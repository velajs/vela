import { access } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Type, VelaApplication } from '@velajs/vela';

/**
 * A `vela.config.{js,mjs,ts}` default-exports (or exports `config`) this shape.
 * You wire your runtime bindings inside `createApp` — e.g. via miniflare for a
 * Cloudflare Worker, or a plain Node adapter — and return a built app.
 *
 * ```ts
 * // vela.config.ts
 * import { defineVelaConfig } from '@velajs/cli/config';
 * export default defineVelaConfig({
 *   async createApp() {
 *     const { createCloudflareApp } = await import('@velajs/cloudflare');
 *     return createCloudflareApp(AppModule);
 *   },
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
export function defineVelaConfig(config: VelaConfig): VelaConfig {
  return config;
}

const CANDIDATES = ['vela.config.js', 'vela.config.mjs', 'vela.config.ts'];

/**
 * Locate + import the vela config. `.ts` requires a runtime that strips types
 * (Node 22+ `--experimental-strip-types`, or tsx/ts-node); `.js`/`.mjs` load
 * directly.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  explicitPath?: string,
): Promise<VelaConfig> {
  const path = explicitPath
    ? isAbsolute(explicitPath)
      ? explicitPath
      : resolve(cwd, explicitPath)
    : await findConfig(cwd);

  if (!path) {
    throw new Error(
      `No vela config found. Create one of: ${CANDIDATES.join(', ')} (or pass --config <path>).`,
    );
  }

  const mod = (await import(pathToFileURL(path).href)) as {
    default?: VelaConfig;
    config?: VelaConfig;
  };
  const config = mod.default ?? mod.config;
  if (!config || typeof config.createApp !== 'function') {
    throw new Error(
      `Config at ${path} must export { createApp(): Promise<VelaApplication> } (default export or a named 'config').`,
    );
  }
  return config;
}

async function findConfig(cwd: string): Promise<string | undefined> {
  for (const name of CANDIDATES) {
    const candidate = join(cwd, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}
