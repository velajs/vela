import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsdown';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Real workerd: Studio's run-now of a job that injects the Cloudflare trigger event.
let runtime: Miniflare | undefined;
let directory: string | undefined;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vela-studio-schedule-'));
  await build({
    config: false,
    entry: ['__tests__/fixtures/schedule-worker.ts'],
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
          name: 'studio-schedule',
          type: 'worker',
          compatibilityDate: '2026-09-20',
          manifest: { mainModule: 'schedule-worker.js', modules },
          env: { VELA_STUDIO_TOKEN: { type: 'text', value: 'worker-schedule-token' } },
        },
      },
    ],
  });
}, 30_000);
afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('lists the request-scoped job that reads the scheduled trigger event', async () => {
  const response = await runtime!.dispatchFetch(
    'https://worker.test/_vela/admin/rpc/schedule.jobs',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer worker-schedule-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ args: {} }),
    },
  );
  expect(await response.json()).toMatchObject({
    ok: true,
    data: [{ name: 'nightly', kind: 'cron', expression: '30 2 * * *' }],
  });
  expect(response.status).toBe(200);
}, 30_000);

it('runs a job that reads the scheduled trigger event now', async () => {
  const response = await runtime!.dispatchFetch(
    'https://worker.test/_vela/admin/rpc/schedule.runNow',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer worker-schedule-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ args: { id: 'nightly' } }),
    },
  );
  expect(await response.json()).toMatchObject({ ok: true, data: { ok: true } });
  expect(response.status).toBe(200);
}, 30_000);
