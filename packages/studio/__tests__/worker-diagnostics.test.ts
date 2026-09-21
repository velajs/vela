import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsdown';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseStudioRpcResponse } from '@velajs/studio-protocol';
let runtime: Miniflare | undefined;
let directory: string | undefined;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vela-studio-worker-'));
  await build({
    config: false,
    entry: ['__tests__/fixtures/diagnostics-worker.ts'],
    outDir: directory,
    format: ['esm'],
    dts: false,
    sourcemap: true,
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
          name: 'studio-diagnostics',
          type: 'worker',
          compatibilityDate: '2026-09-20',
          manifest: { mainModule: 'diagnostics-worker.js', modules },
        },
      },
    ],
  });
}, 30_000);
afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('captures and validates isolated diagnostics in workerd without Node compatibility', async () => {
  const emit = await runtime!.dispatchFetch('https://worker.test/emit');
  const emitted: unknown = await emit.json();
  expect(emitted).toMatchObject({ isolated: true, invocationId: expect.any(String) });
  const response = await runtime!.dispatchFetch('https://worker.test/_vela/admin/rpc/logs.tail', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: '{}',
  });
  const result = parseStudioRpcResponse('logs.tail', await response.json());
  expect(response.status).toBe(200);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected captured diagnostics');
  expect(result.data).toHaveLength(2);
  expect(result.data[0]?.invocation).toMatchObject({
    kind: 'queue',
    moduleId: 'worker-owner',
    boundary: 'handler',
    outcome: 'returned',
    invocationId: expect.any(String),
  });
  expect(JSON.stringify(result)).not.toContain('hidden-password');
  expect(
    (
      await runtime!.dispatchFetch('https://worker.test/_vela/admin/rpc/logs.tail', {
        method: 'POST',
      })
    ).status,
  ).toBe(401);
}, 30_000);
