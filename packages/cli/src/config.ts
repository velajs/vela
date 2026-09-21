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
 * // vela.config.mjs — run `pnpm build` before using app-aware commands.
 * import { defineVelaConfig } from '@velajs/cli/config';
 * import { VelaFactory } from '@velajs/vela';
 * import { AppModule } from './dist/app.module.js';
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

/**
 * Locate and import a config using Node's loader. Node 24 can strip erasable
 * types in `.ts` configs, but does not emit legacy decorators or DI metadata.
 * Import compiled application `.js` from the config (e.g. the SWC build used
 * by Wrangler). This loader does not install compiler or path-alias hooks.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  explicitPath?: string,
): Promise<VelaConfig> {
  const { path } = await resolveConfig(cwd, explicitPath);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new Error(
      `Could not import config at ${path}: ${cause instanceof Error ? cause.message : String(cause)}\n` +
        'Configs run in Node. Compile decorated application source with SWC (legacyDecorator + decoratorMetadata) ' +
        'or an equivalent metadata-emitting compiler, then import its compiled .js files with explicit extensions. ' +
        'Run your application build first; native TypeScript stripping does not transform decorators or tsconfig paths.',
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
