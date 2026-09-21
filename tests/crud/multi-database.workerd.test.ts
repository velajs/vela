import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsdown';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';

let first: Miniflare, second: Miniflare, directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vela-multiple-workers-'));
  await build({
    config: false,
    entry: ['tests/crud/fixtures/multi-database-worker.ts'],
    outDir: directory,
    format: ['esm'],
    dts: false,
    sourcemap: false,
    platform: 'neutral',
    target: 'es2024',
    deps: { alwaysBundle: [/.*/], neverBundle: ['cloudflare:workers'] },
    logLevel: 'silent',
  });
  const modules: Record<string, { type: 'esm'; contents: string }> = {};
  for (const file of await readdir(directory))
    if (file.endsWith('.js'))
      modules[file] = { type: 'esm', contents: await readFile(join(directory, file), 'utf8') };
  const create = (name: string) =>
    new Miniflare({
      workers: [
        {
          config: {
            name,
            type: 'worker',
            compatibilityDate: '2026-09-20',
            manifest: { mainModule: 'multi-database-worker.js', modules },
            exports: { ComposedDatabase: { type: 'durable-object', storage: 'sqlite' } },
            env: {
              PRIMARY_DB: { type: 'd1', id: `${name}-primary` },
              ANALYTICS_DB: { type: 'd1', id: `${name}-analytics` },
              OBJECTS: { type: 'durable-object', worker: name, exportName: 'ComposedDatabase' },
            },
          },
        },
      ],
    });
  first = create('first');
  second = create('second');
  for (const runtime of [first, second])
    for (const binding of ['PRIMARY_DB', 'ANALYTICS_DB']) {
      const database = await runtime.getD1Database(binding);
      await database.exec(
        await readFile(
          `apps/multi-database/migrations/${binding === 'PRIMARY_DB' ? 'primary' : 'analytics'}/0001_items.sql`,
          'utf8',
        ),
      );
    }
}, 30000);
afterAll(async () => {
  await Promise.all([first?.dispose(), second?.dispose()]);
  if (directory) await rm(directory, { recursive: true, force: true });
});
const json = (title: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'same', title }),
});

it('runs the two-D1 example in two environments without Node compatibility', async () => {
  const responses = await Promise.all([
    first.dispatchFetch('https://test/primary/items', json('first-primary')),
    first.dispatchFetch('https://test/analytics/items', json('first-analytics')),
    second.dispatchFetch('https://test/primary/items', json('second-primary')),
    second.dispatchFetch('https://test/analytics/items', json('second-analytics')),
  ]);
  for (const response of responses) expect(response.status, await response.text()).toBe(201);
  for (const [runtime, prefix] of [
    [first, 'first'],
    [second, 'second'],
  ] as const) {
    for (const database of ['primary', 'analytics']) {
      const response = await runtime.dispatchFetch(`https://test/${database}/items/same`);
      expect(await response.json()).toMatchObject({ result: { title: `${prefix}-${database}` } });
    }
  }
}, 30000);

it('rejects native foreign/expired D1 scopes and unsupported callback transactions', async () => {
  const response = await first.dispatchFetch('https://test/capabilities');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({
    d1Rejected: true,
    callbackSkipped: true,
    foreign: true,
    expired: true,
  });
}, 30000);

it('composes resources inside one real Durable Object SQLite transaction', async () => {
  const response = await first.dispatchFetch('https://test/object-check');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({
    rollback: true,
    empty: true,
    quiet: true,
    committed: true,
    expired: true,
    ordered: true,
  });
}, 30000);
