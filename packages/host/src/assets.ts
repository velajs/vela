/**
 * Resolve + read the prebuilt standalone Studio assets shipped by
 * `@velajs/studio-ui` (`dist/standalone/studio.js` + its code-split
 * `chunk-*.js` siblings + `styles.css`).
 *
 * `@velajs/studio-ui` is an OPTIONAL peer: every loader degrades gracefully —
 * returning `undefined` (with a one-time warning) — when the package isn't
 * installed or hasn't been built, so a missing UI never crashes the host.
 *
 * `resolveFrom` controls where `@velajs/studio-ui` is resolved from; it defaults
 * to this module's own URL, so node walks up from the host's location to find
 * the UI in the consumer's install.
 */
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { STANDALONE_SCRIPT, STANDALONE_STYLE } from './constants';
import type { StudioAssets, WarnLogger } from './types';

/** The `exports` shape we read off `@velajs/studio-ui`'s package.json. */
interface UiPackageJson {
  exports?: Record<string, { import?: string; default?: string; types?: string } | string>;
}

/**
 * Read the built `./standalone` target ('./dist/standalone/index.js') out of a
 * resolved package.json's `exports`, so the host follows the UI's own layout
 * instead of hard-coding it. Returns the export's relative path, or `undefined`.
 */
function standaloneExportTarget(pkgJsonPath: string): string | undefined {
  let pkg: UiPackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as UiPackageJson;
  } catch {
    return undefined;
  }
  const entry = pkg.exports?.['./standalone'];
  if (entry === undefined) {
    return undefined;
  }
  if (typeof entry === 'string') {
    return entry;
  }
  return entry.import ?? entry.default;
}

/** Emit a warning through whichever method the logger exposes (once-preferred). */
const warn = (logger: WarnLogger | undefined, message: string): void => {
  if (logger?.warnOnce !== undefined) {
    logger.warnOnce(message);
    return;
  }
  logger?.warn?.(message);
};

/**
 * Absolute path of `@velajs/studio-ui`'s built `dist/standalone` directory —
 * where the `studio.js` entry and its `chunk-*.js` siblings live — or
 * `undefined` when the UI isn't installed/built. The bundle is emitted with
 * esbuild `splitting`, so the host serves the whole directory (not fixed paths).
 */
export function resolveStandaloneDirectory(
  resolveFrom: string = import.meta.url,
): string | undefined {
  try {
    const require = createRequire(resolveFrom);
    // The `./standalone` export is ESM-only (`import`), so a CJS `require.resolve`
    // can't see it; the always-resolvable `./package.json` anchors the package
    // root, and the export map points at the built bundle beside `index.js`.
    const pkgJsonPath = require.resolve('@velajs/studio-ui/package.json');
    const target = standaloneExportTarget(pkgJsonPath);
    if (target === undefined) {
      return undefined;
    }
    return dirname(resolve(dirname(pkgJsonPath), target));
  } catch {
    return undefined;
  }
}

/**
 * Presence + identity of the standalone assets, with a one-time warning when
 * the UI can't be resolved or the built `studio.js` / `styles.css` are missing.
 * Hosts cache this for the session but re-check {@link studioAssetsStamp} per
 * request so a mid-session rebuild is picked up live.
 */
export function loadStudioAssets(
  logger?: WarnLogger,
  resolveFrom: string = import.meta.url,
): StudioAssets | undefined {
  const dir = resolveStandaloneDirectory(resolveFrom);
  if (dir === undefined) {
    warn(logger, '[vela] studio assets unavailable (install + build @velajs/studio-ui?)');
    return undefined;
  }
  try {
    statSync(join(dir, STANDALONE_SCRIPT));
    statSync(join(dir, STANDALONE_STYLE));
  } catch {
    warn(logger, `[vela] studio assets not built (run: pnpm --filter @velajs/studio-ui build)`);
    return undefined;
  }
  return { dir, scriptFile: STANDALONE_SCRIPT, styleFile: STANDALONE_STYLE };
}

/**
 * A freshness stamp for the standalone assets: the latest mtime (ms) of the
 * resolved `studio.js` / `styles.css`, or `undefined` when they can't be
 * resolved. Compared per request so a `@velajs/studio-ui` rebuild mid-session is
 * picked up without a host restart.
 */
export function studioAssetsStamp(resolveFrom: string = import.meta.url): number | undefined {
  const dir = resolveStandaloneDirectory(resolveFrom);
  if (dir === undefined) {
    return undefined;
  }
  try {
    const scriptMtime = statSync(join(dir, STANDALONE_SCRIPT)).mtimeMs;
    const styleMtime = statSync(join(dir, STANDALONE_STYLE)).mtimeMs;
    return Math.max(scriptMtime, styleMtime);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a plain filename to an absolute path that is a **direct child** of
 * `directory`, or `undefined` when the name would escape it. Pure path math (no
 * I/O): the traversal guard behind {@link readStandaloneAsset}. Rejects empty
 * names, `.`/`..`, path separators, NUL, and any resolved path that isn't a lone
 * segment inside `directory`.
 */
export function resolveContainedFile(directory: string, fileName: string): string | undefined {
  if (
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    return undefined;
  }

  const resolved = normalize(join(directory, fileName));
  const relativePath = relative(directory, resolved);

  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath) ||
    relativePath.includes('/') ||
    relativePath.includes('\\')
  ) {
    return undefined;
  }

  return resolved;
}

/**
 * Read a single file from the standalone directory by its plain filename (the
 * `studio.js` entry, a `chunk-*.js`, `styles.css`, or a `.map`).
 * **Path-traversal-safe** via {@link resolveContainedFile}: only a lone filename
 * resolving to a direct child of the standalone directory is served — any
 * separator, `..`, NUL, or absolute path is rejected, so `../../etc/passwd` can
 * never escape it. Returns the bytes, or `undefined` when the UI isn't built or
 * the name doesn't resolve to a file inside the directory.
 */
export function readStandaloneAsset(
  fileName: string,
  resolveFrom: string = import.meta.url,
): Buffer | undefined {
  const directory = resolveStandaloneDirectory(resolveFrom);
  if (directory === undefined) {
    return undefined;
  }

  const resolved = resolveContainedFile(directory, fileName);
  if (resolved === undefined) {
    return undefined;
  }

  try {
    return readFileSync(resolved);
  } catch {
    return undefined;
  }
}

/**
 * True when `pathname`'s basename addresses a standalone JS module — the
 * `studio.js` entry or one of its code-split `chunk-*.js` siblings (and their
 * `.map`s). The stylesheet is matched separately at the style path.
 */
export function isStandaloneModulePath(pathname: string): boolean {
  return pathname.endsWith('.js') || pathname.endsWith('.js.map');
}

/**
 * Content-Type for a served standalone asset, by extension: `.css` → CSS,
 * `.map` → JSON (a source map), everything else (`.js` entry + chunks) →
 * JavaScript.
 */
export function assetContentType(fileName: string): string {
  if (fileName.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (fileName.endsWith('.map')) {
    return 'application/json; charset=utf-8';
  }
  return 'text/javascript; charset=utf-8';
}
