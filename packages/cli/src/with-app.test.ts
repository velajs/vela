import { Injectable, Module, VelaFactory } from '@velajs/vela';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedVelaConfig, VelaConfig } from './config.js';
import { withApp } from './with-app.js';

/** A loaded config whose module runner records when it closes. */
function loadedConfig(config: VelaConfig, dispose = vi.fn(async () => {})): LoadedVelaConfig {
  return { config, path: '/project/vela.config.ts', dispose };
}

describe('command application ownership', () => {
  it('retains the config receiver and waits for work before disposing', async () => {
    @Module({})
    class Root {}
    const app = await VelaFactory.create(Root);
    const dispose = vi.spyOn(app, 'dispose');
    const config = {
      app,
      createApp() {
        return this.app;
      },
    };
    expect(
      await withApp(
        loadedConfig(config),
        async (current) => {
          await Promise.resolve();
          expect(current).toBe(app);
          expect(dispose).not.toHaveBeenCalled();
          return 7;
        },
        vi.fn(),
      ),
    ).toBe(7);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('preserves work failure and disposes constructed resources after a throwing shutdown hook', async () => {
    let released = 0;
    @Injectable()
    class Resource {
      onApplicationShutdown() {
        throw new Error('shutdown failed');
      }
      dispose() {
        released++;
      }
    }
    @Module({ providers: [Resource] })
    class Root {}
    const app = await VelaFactory.create(Root);
    const warn = vi.fn();
    const failure = new Error('work failed');
    await expect(
      withApp(
        loadedConfig({ createApp: () => app }),
        () => {
          throw failure;
        },
        warn,
      ),
    ).rejects.toBe(failure);
    expect(released).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shutdown failed'));
  });

  it('preserves successful exit codes when teardown and diagnostics fail', async () => {
    @Module({})
    class Root {}
    const app = await VelaFactory.create(Root);
    vi.spyOn(app, 'dispose').mockRejectedValue(new Error('teardown failed'));
    const cleanup = vi.spyOn(app.getContainer(), 'dispose');
    expect(
      await withApp(
        loadedConfig({ createApp: () => app }),
        () => 0,
        () => {
          throw new Error('stream closed');
        },
      ),
    ).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('propagates app creation failures without running work', async () => {
    const failure = new Error('bootstrap failed');
    const work = vi.fn();
    const loaded = loadedConfig({
      createApp() {
        throw failure;
      },
    });
    await expect(withApp(loaded, work, vi.fn())).rejects.toBe(failure);
    expect(work).not.toHaveBeenCalled();
    // The module runner still closes, so the command can exit.
    expect(loaded.dispose).toHaveBeenCalledOnce();
  });

  it('closes the config module runner only after the app is disposed', async () => {
    @Module({})
    class Root {}
    const app = await VelaFactory.create(Root);
    const events: string[] = [];
    vi.spyOn(app, 'dispose').mockImplementation(async () => {
      events.push('app');
    });
    const loaded = loadedConfig(
      { createApp: () => app },
      vi.fn(async () => {
        events.push('runner');
      }),
    );
    expect(
      await withApp(
        loaded,
        () => {
          events.push('work');
          return 3;
        },
        vi.fn(),
      ),
    ).toBe(3);
    expect(events).toEqual(['work', 'app', 'runner']);
  });

  it('reports a failing runner close without replacing the result', async () => {
    @Module({})
    class Root {}
    const app = await VelaFactory.create(Root);
    const warn = vi.fn();
    const loaded = loadedConfig(
      { createApp: () => app },
      vi.fn(async () => {
        throw new Error('runner close failed');
      }),
    );
    expect(await withApp(loaded, () => 'done', warn)).toBe('done');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('runner close failed'));
  });
});
