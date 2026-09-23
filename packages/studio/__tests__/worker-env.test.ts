import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsdown';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Real workerd: the Worker's secret reaches Studio through the ENV that
// @velajs/cloudflare seeds, with no token in the module options.
let runtime: Miniflare | undefined;
let directory: string | undefined;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vela-studio-env-'));
  await build({
    config: false,
    entry: ['__tests__/fixtures/env-worker.ts'],
    outDir: directory,
    format: ['esm'],
    dts: false,
    sourcemap: false,
    platform: 'neutral',
    target: 'es2024',
    deps: { alwaysBundle: [/.*/], neverBundle: ['cloudflare:workers'] },
    logLevel: 'silent',
  });
  const modules = Object.fromEntries(
    await Promise.all(
      (await readdir(directory))
        .filter((file) => file.endsWith('.js'))
        .map(async (file) => [
          file,
          { type: 'esm' as const, contents: await readFile(join(directory!, file), 'utf8') },
        ]),
    ),
  );
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: 'studio-env',
          type: 'worker',
          compatibilityDate: '2026-09-20',
          manifest: { mainModule: 'env-worker.js', modules },
          env: { VELA_STUDIO_TOKEN: { type: 'text', value: 'worker-env-token' } },
        },
      },
    ],
  });
}, 30_000);
afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function rpc(token: string): Parameters<Miniflare['dispatchFetch']>[1] {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  };
}

it('enables Studio with the VELA_STUDIO_TOKEN secret from the Worker ENV', async () => {
  const health = await runtime!.dispatchFetch('https://worker.test/_vela/admin/health');
  expect(await health.json()).toMatchObject({ enabled: true });
  const url = 'https://worker.test/_vela/admin/rpc/app.routes';
  expect((await runtime!.dispatchFetch(url, rpc('worker-env-token'))).status).toBe(200);
  expect((await runtime!.dispatchFetch(url, rpc('wrong-token'))).status).toBe(401);
}, 30_000);
