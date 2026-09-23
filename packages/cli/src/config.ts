import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Type, VelaApplication } from '@velajs/vela';

/**
 * A `vela.config.{js,mjs,ts}` default-exports (or exports `config`) this shape.
 * You wire your runtime bindings inside `createApp` — e.g. via miniflare for a
 * Cloudflare Worker, or a plain Node adapter — and return a built app.
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
   * The app's root module class — needed only by commands that work from
   * module metadata rather than the built app (`vela openapi dump`, `vela client generate`).
   */
  rootModule?: Type;
}

/** Identity helper for type-safe config files. */
export function defineVelaConfig<const Config extends VelaConfig>(config: Config): Config {
  return config;
}

const CANDIDATES = ['vela.config.js', 'vela.config.mjs', 'vela.config.ts'];

/** Oxc output Vela's DI reads: legacy decorators plus `design:paramtypes` metadata. */
const DECORATOR_TRANSFORM = { decorator: { legacy: true, emitDecoratorMetadata: true } };

type Vite = typeof import('vite');

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
 * Locate and import a config. When the project installs Vite 8, the config
 * and the application files it imports load through Vite's module runner,
 * compiled by Oxc with legacy decorators and constructor metadata, so a
 * config can import decorated `src/` files directly; packages load from
 * node_modules as usual. Without Vite, Node imports the config: it strips
 * erasable types from `.ts` files but emits no decorators or DI metadata, so
 * such a config must import compiled `.js` files.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  explicitPath?: string,
): Promise<VelaConfig> {
  const { path } = await resolveConfig(cwd, explicitPath);
  const vite = await importVite();
  let mod: unknown;
  try {
    mod = vite
      ? (
          await vite.runnerImport<unknown>(path, {
            root: resolve(cwd),
            logLevel: 'error',
            oxc: DECORATOR_TRANSFORM,
          })
        ).module
      : await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new Error(
      `Could not import config at ${path}: ${cause instanceof Error ? cause.message : String(cause)}\n` +
        (vite
          ? "The config and the files it imports ran through Vite's module runner (Oxc, legacy " +
            'decorators and decorator metadata); packages load from node_modules.'
          : 'Configs run in Node without Vite. Node strips erasable TypeScript types but does not ' +
            'transform decorators, emit DI metadata or apply tsconfig paths. Install vite 8 in the ' +
            'project so the CLI loads decorated sources through Vite, or import compiled .js files ' +
            'with explicit extensions.'),
      { cause },
    );
  }
  const config = isRecord(mod) ? (mod.default ?? mod.config) : undefined;
  if (!isVelaConfig(config)) {
    throw new Error(
      `Config at ${path} must export an object with createApp(): VelaApplication | Promise<VelaApplication> ` +
        "(default export or a named 'config'); rootModule, when provided, must be a constructor.",
    );
  }
  return config;
}

export interface ConfigResolution {
  readonly path: string;
  readonly source: 'explicit' | 'discovered';
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
      if (!(await stat(candidate)).isFile()) {
        throw new Error(`Config at ${candidate} must be a file.`);
      }
      return {
        path: candidate,
        source: explicitPath === undefined ? 'discovered' : 'explicit',
        candidates: checked,
      };
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(
    `No vela config found. Checked: ${checked.join(', ')}. Create one of: ${CANDIDATES.join(', ')} (or pass --config <path>).`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isConstructor(value: unknown): value is Type {
  if (typeof value !== 'function') return false;
  try {
    // Validate constructability without invoking the user's constructor.
    Reflect.construct(Object, [], value);
    return true;
  } catch {
    return false;
  }
}

function isVelaConfig(value: unknown): value is VelaConfig {
  return (
    isRecord(value) &&
    typeof value.createApp === 'function' &&
    (value.rootModule === undefined || isConstructor(value.rootModule))
  );
}
