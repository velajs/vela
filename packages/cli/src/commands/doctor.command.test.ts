import { PassThrough } from 'node:stream';
import {
  Injectable,
  Module,
  VelaFactory,
  registerEntrypointKind,
  defineProvider,
  InjectionToken,
} from '@velajs/vela';
import { Cli } from 'clipanion';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolveConfig, type LoadedVelaConfig, type VelaConfig } from '../config.js';
import { DoctorCommand } from './doctor.command.js';

vi.mock('../config.js', () => ({ loadConfig: vi.fn(), resolveConfig: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

/** A loaded config as loadConfig() returns it, with a runner that has nothing to close. */
function loadedConfig(config: VelaConfig): LoadedVelaConfig {
  return { config, path: '/project/vela.config.ts', dispose: vi.fn(async () => {}) };
}

async function run(args: string[] = []) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  let errors = '';
  stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  const code = await Cli.from([DoctorCommand]).run(['doctor', '--json', ...args], {
    stdout,
    stderr,
  });
  return { code, output, errors };
}

describe('vela doctor', () => {
  it('documents inspecting the app from the TypeScript config the CLI loads through Vite', () => {
    expect(DoctorCommand.usage?.examples).toContainEqual([
      'Inspect the app',
      'vela doctor --app --config vela.config.ts --json',
    ]);
  });

  it('explains config resolution without loading the config', async () => {
    const resolution = {
      path: '/project/vela.config.mjs',
      source: 'discovered' as const,
      candidates: ['/project/vela.config.js', '/project/vela.config.mjs'],
    };
    vi.mocked(resolveConfig).mockResolvedValue(resolution);
    const result = await run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      schemaVersion: 1,
      config: resolution,
      issues: [],
    });
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('reports missing configuration as JSON with a failing exit code', async () => {
    vi.mocked(resolveConfig).mockRejectedValue(new Error('No vela config found'));
    const result = await run();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      config: null,
      issues: ['No vela config found'],
    });
  });

  it('uses app-local snapshots, leaves lazy providers unconstructed and never serializes values', async () => {
    let constructed = 0;
    @Injectable()
    class LazyService {
      constructor() {
        constructed++;
      }
    }
    @Module({ lazy: true, providers: [LazyService] })
    class LazyModule {}
    const SECRET = new InjectionToken<string>('doctor:secret');
    @Module({
      imports: [LazyModule],
      providers: [defineProvider(SECRET, { useValue: 'do-not-print' })],
    })
    class First {}
    @Module({})
    class Second {}
    // Declarations from an unrelated app must not appear as empty kinds.
    registerEntrypointKind({
      kind: 'doctor-unrelated',
      metaKey: 'doctor:unrelated',
      level: 'class',
    });
    for (const root of [First, Second]) {
      const app = await VelaFactory.create(root);
      const dispose = vi.spyOn(app, 'dispose');
      vi.mocked(resolveConfig).mockResolvedValue({
        path: `/project/${root.name}.mjs`,
        source: 'explicit',
        candidates: [],
      });
      vi.mocked(loadConfig).mockResolvedValue(loadedConfig({ createApp: () => app }));
      const result = await run(['--app']);
      expect(result.code).toBe(0);
      expect(result.output).not.toContain('do-not-print');
      expect(result.output).not.toContain('doctor-unrelated');
      expect(
        JSON.parse(result.output).application.modules.some(
          (module: { lazy: boolean; providers: string[] }) =>
            module.lazy && module.providers.includes('LazyService'),
        ),
      ).toBe(root === First);
      expect(constructed).toBe(0);
      expect(dispose).toHaveBeenCalledOnce();
    }
  });

  it('disposes after snapshot failure and returns structured diagnostics', async () => {
    @Module({})
    class Root {}
    const app = await VelaFactory.create(Root);
    const dispose = vi.spyOn(app, 'dispose');
    vi.spyOn(app.getContainer(), 'getModuleDescriptions').mockImplementation(() => {
      throw new Error('snapshot failed');
    });
    vi.mocked(resolveConfig).mockResolvedValue({
      path: '/project/config.mjs',
      source: 'explicit',
      candidates: [],
    });
    vi.mocked(loadConfig).mockResolvedValue(loadedConfig({ createApp: () => app }));
    const result = await run(['--app']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).issues).toEqual(['snapshot failed']);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
