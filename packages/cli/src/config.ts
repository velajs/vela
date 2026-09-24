import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DynamicModule, Type, VelaApplication } from '@velajs/vela';
import { installCloudflareStubs } from './project/cloudflare-stubs.js';
import { hasErrorCode, isModuleRoot, isRecord } from './project/files.js';
import { openModuleRunner, type ModuleRunner } from './project/module-runner.js';
import {
  findWranglerConfig,
  readWranglerConfig,
  wranglerMain,
  wranglerVars,
  type WranglerConfig,
} from './project/wrangler.js';
import { readWorkerDescriptor } from './project/worker-entry.js';

/**
 * A `vela.config.{js,mjs,ts}` default-exports (or exports `config`) this shape.
 * It is optional: without one, the CLI builds the application the Worker entry
 * exports with `createCloudflareWorker(AppModule)`. Add one to build the app
 * yourself, for example with local binding equivalents:
 *
 * ```ts
 * // vela.config.ts — loaded through Vite when the project installs it.
 * import { defineVelaConfig } from '@velajs/cli/config';
 * import { VelaFactory } from '@velajs/vela';
 * import { AppModule } from './src/app.module.js';
 * export default defineVelaConfig({
 *   rootModule: AppModule,
 *   createApp: () => VelaFactory.create(AppModule),
 * });
 * ```
 */
export interface VelaConfig {
  createApp(): Promise<VelaApplication> | VelaApplication;
  /**
   * The app's root module, a class or a `DynamicModule` — needed only by
   * commands that work from module metadata rather than the built app
   * (`vela openapi dump`, `vela client generate`, `vela mcp serve`).
   */
  rootModule?: Type | DynamicModule;
}

/** Identity helper for type-safe config files. */
export function defineVelaConfig<const Config extends VelaConfig>(config: Config): Config {
  return config;
}

const CANDIDATES = ['vela.config.js', 'vela.config.mjs', 'vela.config.ts'];

/**
 * The environment a Worker loaded without a config is built with:
 * `metadata` seeds ENV with the Wrangler `vars` of the selected environment
 * only (no bindings or secrets), enough for commands that read the module
 * graph, routes and entrypoints; `local` asks Wrangler's `getPlatformProxy()`
 * for local bindings and `.dev.vars` secrets, persisted like `vite dev`.
 */
export type WorkerBindings = 'metadata' | 'local';

export interface LoadConfigOptions {
  /** The Wrangler environment whose `main`, `vars` and bindings apply (top level when omitted). */
  readonly environment?: string;
  readonly bindings?: WorkerBindings;
  /**
   * The Wrangler file to load the Worker entry from when no `vela.config` is
   * found, instead of the default-named one in `cwd`.
   */
  readonly wrangler?: string;
}

/** A config and the module runner that imported it, as {@link loadConfig} returns it. */
export interface LoadedVelaConfig {
  readonly config: VelaConfig;
  /** Absolute path of the imported config file, or of the Wrangler file without one. */
  readonly path: string;
  readonly source: ConfigResolution['source'];
  /** Import another project file through the same module runner (and Workers stand-ins). */
  importModule(path: string): Promise<unknown>;
  /**
   * Closes the Vite module runner that imported the config, after which files
   * the config imports lazily (`await import('./src/app.module.js')`) can no
   * longer load, and the local Wrangler platform the app used. Call it once
   * the app is disposed; a config Node imported has nothing to close.
   */
  dispose(): Promise<void>;
}

/**
 * Locate and load the application: a `vela.config` (explicit or discovered in
 * `cwd`), or else the Worker entry named by the Wrangler file's `main`. When
 * the project installs Vite 8, files load through a Vite module runner,
 * compiled by Oxc with legacy decorators and constructor metadata, so they
 * import decorated `src/` files directly, eagerly or later; packages load from
 * node_modules as usual, and `cloudflare:*` modules resolve to inert Node
 * stand-ins. The runner stays open until `dispose()`. Without Vite, Node
 * imports the files: it strips erasable types from `.ts` files but emits no
 * decorators or DI metadata, so they must import compiled `.js` files.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  explicitPath?: string,
  options: LoadConfigOptions = {},
): Promise<LoadedVelaConfig> {
  let resolution: ConfigResolution;
  try {
    resolution = await resolveConfig(cwd, explicitPath);
  } catch (error) {
    if (options.wrangler === undefined || explicitPath !== undefined) throw error;
    resolution = { path: resolve(cwd, options.wrangler), source: 'wrangler', candidates: [] };
  }
  if (resolution.source === 'wrangler' && options.wrangler !== undefined) {
    resolution = { ...resolution, path: resolve(cwd, options.wrangler) };
  }
  installCloudflareStubs();
  const root = resolve(cwd);
  const runner = await openModuleRunner(root);
  try {
    return resolution.source === 'wrangler'
      ? await loadWorker(runner, resolution.path, options)
      : await loadConfigFile(runner, resolution.path, resolution.source);
  } catch (error) {
    await runner.close();
    throw error;
  }
}

function importFailure(runner: ModuleRunner, what: string, cause: unknown): Error {
  return new Error(
    `Could not import ${what}: ${cause instanceof Error ? cause.message : String(cause)}\n` +
      (runner.kind === 'vite'
        ? "The file and the files it imports ran through Vite's module runner (Oxc, legacy " +
          'decorators and decorator metadata); packages load from node_modules.'
        : 'Files run in Node without Vite. Node strips erasable TypeScript types but does not ' +
          'transform decorators, emit DI metadata or apply tsconfig paths. Install vite 8 in the ' +
          'project so the CLI loads decorated sources through Vite, or import compiled .js files ' +
          'with explicit extensions.'),
    { cause },
  );
}

async function loadConfigFile(
  runner: ModuleRunner,
  path: string,
  source: ConfigResolution['source'],
): Promise<LoadedVelaConfig> {
  let mod: unknown;
  try {
    mod = await runner.import(path);
  } catch (cause) {
    throw importFailure(runner, `config at ${path}`, cause);
  }
  const config = isRecord(mod) ? (mod.default ?? mod.config) : undefined;
  if (!isVelaConfig(config)) {
    throw new Error(
      `Config at ${path} must export an object with createApp(): VelaApplication | Promise<VelaApplication> ` +
        "(default export or a named 'config'); rootModule, when provided, must be a module class or a DynamicModule.",
    );
  }
  return {
    config,
    path,
    source,
    importModule: (file) => runner.import(file),
    dispose: () => runner.close(),
  };
}

/** Build the application `createCloudflareWorker()` describes, as the Worker does. */
async function loadWorker(
  runner: ModuleRunner,
  wranglerPath: string,
  { environment, bindings = 'metadata' }: LoadConfigOptions,
): Promise<LoadedVelaConfig> {
  const wrangler = await readWranglerConfig(wranglerPath);
  const main = wranglerMain(wrangler, environment);
  let entry: unknown;
  try {
    entry = await runner.import(main);
  } catch (cause) {
    throw importFailure(runner, `the Worker entry ${main}`, cause);
  }
  const descriptor = readWorkerDescriptor(entry, main);
  const vars = wranglerVars(wrangler, environment);
  const platforms: Array<{ dispose(): Promise<void> }> = [];
  const config: VelaConfig = {
    rootModule: descriptor.rootModule,
    async createApp() {
      const env =
        bindings === 'local' ? await localBindings(wrangler, environment, platforms) : vars;
      const app = await descriptor.createApplication(env);
      if (!isApplication(app)) throw new Error(`${main} did not build a Vela application.`);
      return app;
    },
  };
  return {
    config,
    path: wrangler.path,
    source: 'wrangler',
    importModule: (file) => runner.import(file),
    async dispose() {
      try {
        await runner.close();
      } finally {
        await Promise.all(platforms.splice(0).map((platform) => platform.dispose()));
      }
    },
  };
}

function isApplication(value: unknown): value is VelaApplication {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'describeRoutes') === 'function' &&
    typeof Reflect.get(value, 'getContainer') === 'function'
  );
}

/** Local bindings from the project's own Wrangler, closed with the loaded config. */
async function localBindings(
  wrangler: WranglerConfig,
  environment: string | undefined,
  platforms: Array<{ dispose(): Promise<void> }>,
): Promise<Record<string, unknown>> {
  const project = dirname(wrangler.path);
  let wranglerEntry: string;
  try {
    wranglerEntry = createRequire(join(project, 'package.json')).resolve('wrangler');
  } catch (cause) {
    throw new Error(
      'Local bindings need Wrangler in the project: install wrangler as a dev dependency.',
      { cause },
    );
  }
  const module: unknown = await import(pathToFileURL(wranglerEntry).href);
  const getPlatformProxy = isRecord(module) ? module.getPlatformProxy : undefined;
  if (typeof getPlatformProxy !== 'function') {
    throw new Error("The project's Wrangler has no getPlatformProxy(); update wrangler.");
  }
  const platform: unknown = await getPlatformProxy({
    configPath: wrangler.path,
    ...(environment === undefined ? {} : { environment }),
  });
  if (!isRecord(platform) || !isRecord(platform.env) || typeof platform.dispose !== 'function') {
    throw new Error("Wrangler's getPlatformProxy() returned an unexpected value.");
  }
  const dispose = platform.dispose;
  platforms.push({ dispose: async () => void (await Reflect.apply(dispose, platform, [])) });
  return platform.env;
}

export interface ConfigResolution {
  readonly path: string;
  /**
   * `explicit` (`--config`), `discovered` (a `vela.config` in the working
   * directory) or `wrangler` (no config: the Worker entry the Wrangler file names).
   */
  readonly source: 'explicit' | 'discovered' | 'wrangler';
  /** Absolute paths checked in order, ending at the selected file. */
  readonly candidates: readonly string[];
}

/** Resolve provenance without importing application code or walking parent directories. */
export async function resolveConfig(
  cwd: string = process.cwd(),
  explicitPath?: string,
): Promise<ConfigResolution> {
  if (explicitPath !== undefined && explicitPath.trim() === '') {
    throw new Error('--config must name a file.');
  }
  const candidates =
    explicitPath === undefined
      ? CANDIDATES.map((name) => join(resolve(cwd), name))
      : [resolve(cwd, explicitPath)];
  const checked: string[] = [];
  for (const candidate of candidates) {
    checked.push(candidate);
    try {
      // eslint-disable-next-line no-await-in-loop -- Precedence: stop at the first file.
      if (!(await stat(candidate)).isFile()) {
        throw new Error(`Config at ${candidate} must be a file.`);
      }
      return {
        path: candidate,
        source: explicitPath === undefined ? 'discovered' : 'explicit',
        candidates: checked,
      };
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  if (explicitPath === undefined) {
    const wrangler = await findWranglerConfig(cwd);
    checked.push(...wrangler.candidates);
    if (wrangler.path !== undefined) {
      return { path: wrangler.path, source: 'wrangler', candidates: checked };
    }
  }
  throw new Error(
    `No vela config or Wrangler configuration found. Checked: ${checked.join(', ')}. ` +
      `Run the command in a Worker project (wrangler.jsonc whose main exports ` +
      `createCloudflareWorker(AppModule)), create one of ${CANDIDATES.join(', ')}, or pass --config <path>.`,
  );
}

function isVelaConfig(value: unknown): value is VelaConfig {
  return (
    isRecord(value) &&
    typeof value.createApp === 'function' &&
    (value.rootModule === undefined || isModuleRoot(value.rootModule))
  );
}
