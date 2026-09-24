import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  starterArchiveOverrides,
  starterManifests,
  starterPinMismatches,
  starterTemplates,
  syncStarterPins,
} from '../../scripts/starter-pins.mjs';

const starter = {
  name: '__PROJECT_NAME__',
  dependencies: { '@velajs/cloudflare': '1.24.0', '@velajs/vela': '1.27.0', hono: '4.13.8' },
  devDependencies: { typescript: '7.0.2', wrangler: '4.135.0' },
};
const workspace = new Map([
  ['@velajs/vela', '1.29.0'],
  ['@velajs/cloudflare', '1.29.0'],
  ['@velajs/cli', '1.29.0'],
]);

test('report starter framework pins that drift from the workspace versions', () => {
  assert.deepEqual(starterPinMismatches(starter, workspace), [
    'dependencies.@velajs/cloudflare pins 1.24.0, not the workspace version 1.29.0',
    'dependencies.@velajs/vela pins 1.27.0, not the workspace version 1.29.0',
  ]);
  assert.deepEqual(starterPinMismatches(syncStarterPins(starter, workspace), workspace), []);
});

test('sync only workspace packages and leave third-party pins alone', () => {
  const synced = syncStarterPins(starter, workspace);
  assert.deepEqual(synced.dependencies, {
    '@velajs/cloudflare': '1.29.0',
    '@velajs/vela': '1.29.0',
    hono: '4.13.8',
  });
  assert.deepEqual(synced.devDependencies, starter.devDependencies);
  assert.equal(starter.dependencies['@velajs/vela'], '1.27.0', 'the input stays unchanged');
});

test('install the pinned framework and its unpublished dependencies from release archives', () => {
  const archives = {
    '@velajs/vela': 'file:/artifacts/velajs-vela-1.29.0.tgz',
    '@velajs/cloudflare': 'file:/artifacts/velajs-cloudflare-1.29.0.tgz',
    // A dependency of the pinned core, released with it and not on npm yet.
    '@velajs/errors': 'file:/artifacts/velajs-errors-1.23.0.tgz',
  };
  assert.deepEqual(starterArchiveOverrides(starter, archives), {
    '@velajs/cloudflare': 'file:/artifacts/velajs-cloudflare-1.29.0.tgz',
    '@velajs/errors': 'file:/artifacts/velajs-errors-1.23.0.tgz',
    '@velajs/vela': 'file:/artifacts/velajs-vela-1.29.0.tgz',
  });
  assert.throws(
    () => starterArchiveOverrides(starter, { '@velajs/vela': archives['@velajs/vela'] }),
    /@velajs\/cloudflare has no release archive/,
  );
  assert.deepEqual(starterArchiveOverrides(starter, {}), {}, 'after publication: npm only');
});

test('every vela new template has a manifest', async () => {
  assert.deepEqual(starterTemplates, ['minimal', 'api']);
  const manifests = await Promise.all(
    starterManifests.map(async (url) => JSON.parse(await readFile(url, 'utf8'))),
  );
  for (const manifest of manifests) assert.equal(manifest.name, '__PROJECT_NAME__');
});

test('the committed starters pin the current workspace framework versions', async () => {
  const versions = new Map();
  for (const name of ['vela', 'cloudflare', 'cli', 'testing']) {
    const path = new URL(`../../packages/${name}/package.json`, import.meta.url);
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    versions.set(pkg.name, pkg.version);
  }
  for (const url of starterManifests) {
    const manifest = JSON.parse(await readFile(url, 'utf8'));
    // The CLI is a dev dependency so `vela ...` runs the version that scaffolded the project,
    // and the template specs build the app with @velajs/cloudflare/testing.
    assert.ok(manifest.devDependencies['@velajs/cli'], `${url} pins @velajs/cli`);
    assert.ok(manifest.devDependencies['@velajs/testing'], `${url} pins @velajs/testing`);
    assert.deepEqual(starterPinMismatches(manifest, versions), [], String(url));
  }
});

test('the starters pin the workspace catalog toolchain', async () => {
  const workspace = await readFile(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8');
  const block = workspace.match(/^catalog:\n((?: {2}.+\n)+)/m)?.[1] ?? '';
  const catalog = new Map(
    [...block.matchAll(/^ {2}"?([^":]+)"?: (\S+)$/gm)].map(([, name, version]) => [name, version]),
  );
  for (const url of starterManifests) {
    const manifest = JSON.parse(await readFile(url, 'utf8'));
    const pins = { ...manifest.dependencies, ...manifest.devDependencies };
    // @cloudflare/vite-plugin releases pair with a Wrangler release; keep both on the catalog.
    for (const name of [
      '@cloudflare/vite-plugin',
      '@cloudflare/vitest-plugin',
      '@cloudflare/workers-types',
      'hono',
      'typescript',
      'vite',
      'vitest',
      'wrangler',
    ]) {
      assert.equal(pins[name], catalog.get(name), `${url}: ${name} follows the workspace catalog`);
    }
    if (pins.zod !== undefined) assert.equal(pins.zod, catalog.get('zod'), `${url}: zod`);
  }
});
