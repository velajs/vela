import { Injectable, Module, VelaFactory } from '@velajs/vela';
import { describe, expect, it, vi } from 'vitest';
import { withApp } from './with-app.js';

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
        config,
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
        { createApp: () => app },
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
        { createApp: () => app },
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
    await expect(
      withApp(
        {
          createApp() {
            throw failure;
          },
        },
        work,
        vi.fn(),
      ),
    ).rejects.toBe(failure);
    expect(work).not.toHaveBeenCalled();
  });
});
