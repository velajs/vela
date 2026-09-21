import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsdown';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, it, expect } from 'vitest';
let runtime: Miniflare, directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vela-edge-runtime-'));
  await build({
    config: false,
    entry: ['tests/crud/fixtures/edge-worker.ts'],
    outDir: directory,
    format: ['esm'],
    dts: false,
    sourcemap: false,
    platform: 'neutral',
    target: 'es2024',
    deps: { alwaysBundle: [/.*/], neverBundle: ['cloudflare:workers', /\.wasm$/] },
    logLevel: 'silent',
  });
  const modules: Record<
    string,
    { type: 'esm'; contents: string } | { type: 'wasm'; contents: Uint8Array }
  > = {};
  for (const file of await readdir(directory))
    if (file.endsWith('.js'))
      modules[`tests/crud/fixtures/${file}`] = {
        type: 'esm',
        contents: await readFile(join(directory, file), 'utf8'),
      };
  modules['packages/authz-cedar/dist/cloudflare/cedar.wasm'] = {
    type: 'wasm',
    contents: await readFile('packages/authz-cedar/dist/cloudflare/cedar.wasm'),
  };
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: 'vela-edge',
          type: 'worker',
          compatibilityDate: '2026-09-20',
          manifest: { mainModule: 'tests/crud/fixtures/edge-worker.js', modules },
          exports: { EdgeObject: { type: 'durable-object', storage: 'sqlite' } },
          env: {
            DB: { type: 'd1', id: 'edge-db' },
            OBJECTS: { type: 'durable-object', worker: 'vela-edge', exportName: 'EdgeObject' },
            BUCKET: { type: 'r2', name: 'edge-files' },
          },
        },
      },
    ],
  });
}, 30000);
afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
for (const route of ['d1', 'do', 'cedar', 'crypto'])
  it(`runs ${route} in workerd without Node compatibility`, async () => {
    const response = await runtime.dispatchFetch(`https://edge.test/${route}`),
      body = await response.text();
    expect(response.status, body).toBe(200);
    expect(Object.values(JSON.parse(body)).every((v) => v === true)).toBe(true);
  }, 30000);
