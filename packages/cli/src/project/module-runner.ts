import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from './files.js';

/** Oxc output Vela's DI reads: legacy decorators plus `design:paramtypes` metadata. */
const DECORATOR_TRANSFORM = { decorator: { legacy: true, emitDecoratorMetadata: true } };

type Vite = typeof import('vite');

/** Imports application files for one command, then closes. */
export interface ModuleRunner {
  /** `vite` when files load through a Vite module runner, `node` otherwise. */
  readonly kind: 'vite' | 'node';
  import(path: string): Promise<unknown>;
  close(): Promise<void>;
}

// The optional `vite` peer: the project's own Vite 8 when it installs one.
async function importVite(): Promise<Vite | undefined> {
  let vite: Vite;
  try {
    vite = await import('vite');
  } catch (error) {
    // Only a missing `vite` package means "not installed"; a broken install still fails loudly.
    if (
      isRecord(error) &&
      error.code === 'ERR_MODULE_NOT_FOUND' &&
      /'vite'/.test(String(error.message))
    )
      return undefined;
    throw error;
  }
  return Number.parseInt(vite.version, 10) >= 8 ? vite : undefined;
}

/**
 * A module runner for the project at `root`. With Vite 8 installed, files load
 * through a runnable Vite environment configured like Vite's `runnerImport()`
 * but left open (an `import()` the loaded code runs later must still work),
 * compiled by Oxc with legacy decorators and constructor metadata; packages
 * and `cloudflare:*` modules load through Node. Without Vite, Node imports the
 * files: it strips erasable types but emits no decorators or DI metadata.
 */
export async function openModuleRunner(root: string): Promise<ModuleRunner> {
  const vite = await importVite();
  if (!vite) {
    return {
      kind: 'node',
      import: (path) => import(isAbsolute(path) ? pathToFileURL(path).href : path),
      close: async () => {},
    };
  }
  const config = await vite.resolveConfig(
    {
      root,
      logLevel: 'error',
      oxc: DECORATOR_TRANSFORM,
      configFile: false,
      envDir: false,
      cacheDir: process.cwd(),
      environments: {
        inline: {
          consumer: 'server',
          dev: { moduleRunnerTransform: true },
          resolve: {
            external: true,
            mainFields: [],
            conditions: ['node', ...(process.features.require_module ? ['module-sync'] : [])],
            // The Workers runtime modules resolve through the CLI's Node stand-ins.
            builtins: [/^cloudflare:/],
          },
        },
      },
    },
    'serve',
  );
  const environment = vite.createRunnableDevEnvironment('inline', config, {
    runnerOptions: { hmr: { logger: false } },
    hot: false,
  });
  await environment.init();
  return {
    kind: 'vite',
    import: (path) => environment.runner.import(path),
    close: () => environment.close(),
  };
}
