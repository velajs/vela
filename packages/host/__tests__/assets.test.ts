import { statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assetContentType,
  isStandaloneModulePath,
  loadStudioAssets,
  readStandaloneAsset,
  resolveContainedFile,
  resolveStandaloneDirectory,
  studioAssetsStamp,
} from '../src/assets';

// Resolve @velajs/studio-ui from THIS test file (its node_modules symlink lives
// under packages/host). The UI must be built first (the verify script does so).
const FROM = import.meta.url;

describe('resolveContainedFile (traversal guard)', () => {
  const dir = '/srv/standalone';
  it('resolves a lone filename to a direct child', () => {
    expect(resolveContainedFile(dir, 'studio.js')).toBe('/srv/standalone/studio.js');
    expect(resolveContainedFile(dir, 'chunk-ABC.js')).toBe('/srv/standalone/chunk-ABC.js');
  });
  it('rejects traversal, separators, absolute paths, dot segments, and NUL', () => {
    for (const name of [
      '../secret',
      '..',
      '.',
      '',
      'a/b',
      'a\\b',
      '/etc/passwd',
      'x\0y',
      'sub/child.js',
    ]) {
      expect(resolveContainedFile(dir, name)).toBeUndefined();
    }
  });
});

describe('assetContentType / isStandaloneModulePath', () => {
  it('maps extensions to MIME types', () => {
    expect(assetContentType('studio.js')).toContain('javascript');
    expect(assetContentType('styles.css')).toContain('css');
    expect(assetContentType('studio.js.map')).toContain('json');
  });
  it('recognises module paths', () => {
    expect(isStandaloneModulePath('/studio.js')).toBe(true);
    expect(isStandaloneModulePath('/chunk-A.js.map')).toBe(true);
    expect(isStandaloneModulePath('/styles.css')).toBe(false);
  });
});

describe('loadStudioAssets', () => {
  it('resolves the built standalone directory when the UI is present', () => {
    const assets = loadStudioAssets(undefined, FROM);
    expect(assets).toBeDefined();
    expect(assets?.scriptFile).toBe('studio.js');
    expect(resolveStandaloneDirectory(FROM)).toContain('dist/standalone');
  });
  // NOTE: the "UI cannot be resolved" degradation path can't be exercised via
  // `resolveFrom` under vitest — vite's resolver ignores the createRequire base
  // and resolves the workspace package regardless (real Node throws
  // MODULE_NOT_FOUND, verified out-of-band). The handler's 503 build-hint branch
  // is covered deterministically in degradation.test.ts via vi.mock.
});

describe('readStandaloneAsset', () => {
  it('reads the entry bytes', () => {
    const bytes = readStandaloneAsset('studio.js', FROM);
    expect(bytes).toBeInstanceOf(Buffer);
    expect((bytes?.length ?? 0) > 0).toBe(true);
  });
  it('refuses a traversal filename', () => {
    expect(readStandaloneAsset('../../package.json', FROM)).toBeUndefined();
  });
});

describe('studioAssetsStamp (mtime pickup)', () => {
  const dir = resolveStandaloneDirectory(FROM);
  const scriptPath = dir === undefined ? undefined : join(dir, 'studio.js');
  const original = scriptPath === undefined ? undefined : statSync(scriptPath);

  afterEach(() => {
    if (scriptPath !== undefined && original !== undefined) {
      utimesSync(scriptPath, original.atime, original.mtime);
    }
  });

  it('increases when the built entry is rewritten (a mid-session rebuild)', () => {
    expect(scriptPath).toBeDefined();
    const before = studioAssetsStamp(FROM);
    expect(before).toBeDefined();
    const future = new Date(Date.now() + 10_000);
    utimesSync(scriptPath as string, future, future);
    const after = studioAssetsStamp(FROM);
    expect((after ?? 0) > (before ?? 0)).toBe(true);
  });
});
