import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  starterArchiveOverrides,
  starterManifest,
  starterPinMismatches,
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

test('the committed starter pins the current workspace framework versions', async () => {
  const manifest = JSON.parse(await readFile(starterManifest, 'utf8'));
  const versions = new Map();
  for (const name of ['vela', 'cloudflare']) {
    const path = new URL(`../../packages/${name}/package.json`, import.meta.url);
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    versions.set(pkg.name, pkg.version);
  }
  assert.deepEqual(starterPinMismatches(manifest, versions), []);
});
