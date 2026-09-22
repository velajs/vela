import { readFile, readdir } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { executeAtomicBatch, requireAtomicBatch, type CrudTransactionScope } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import {
  createDrizzleReliabilityStore,
  reliabilitySqliteTable,
  prepareOutboxInsert,
} from '../../packages/reliability/src/drizzle';
import { createInbox, createOutbox } from '../../packages/reliability/src';
import {
  claimed,
  contract,
  ddl,
  parsePayload,
  scope,
} from '../../packages/reliability/src/__tests__/support';

async function runtime(
  contents = 'export default { fetch() { return new Response("ok") } }',
  modules: Record<string, { type: 'esm'; contents: string }> = {},
) {
  return new Miniflare({
    workers: [
      {
        config: {
          name: 'delivery',
          type: 'worker',
          compatibilityDate: '2026-09-20',
          manifest: {
            mainModule: 'worker.js',
            modules: { 'worker.js': { type: 'esm', contents }, ...modules },
          },
          env: { DB: { type: 'd1', id: 'delivery' } },
        },
      },
    ],
  });
}
async function setup() {
  const worker = await runtime();
  const native = await worker.getD1Database('DB');
  await native.prepare(ddl('reliability', 'sqlite')).run();
  const db = drizzle(native);
  const table = reliabilitySqliteTable();
  const store = createDrizzleReliabilityStore({ db, table, driver: 'd1' });
  return {
    worker,
    native,
    db,
    table,
    store,
    other: createDrizzleReliabilityStore({ db: drizzle(native), table, driver: 'd1' }),
    shift: async (ms: number) => {
      await native
        .prepare(
          'UPDATE reliability SET available_at = max(0, available_at - ?), lease_until = max(0, lease_until - ?), expires_at = max(0, expires_at - ?)',
        )
        .bind(ms, ms, ms)
        .run();
    },
    reopen: async () => createDrizzleReliabilityStore({ db: drizzle(native), table, driver: 'd1' }),
    close: () => worker.dispose(),
  };
}
contract('native D1 CAS delivery', setup);
it('validates every due payload before spending any attempt in a native CAS poll', async () => {
  const fixture = await setup();
  try {
    const outbox = createOutbox({ store: fixture.store, parsePayload });
    await outbox.enqueue(scope, { id: 'a', payload: { value: 'valid' }, maxAttempts: 1 });
    await outbox.enqueue(scope, { id: 'b', payload: { value: 'valid' } });
    await fixture.native
      .prepare('UPDATE reliability SET payload = ? WHERE id = ?')
      .bind('{"value":42}', 'b')
      .run();
    await expect(outbox.claimDue(scope)).rejects.toThrow('Invalid payload');
    expect(await outbox.get(scope, 'a')).toMatchObject({ state: 'pending', attempt: 0 });
    await fixture.native
      .prepare('UPDATE reliability SET payload = ? WHERE id = ?')
      .bind('{"value":"fixed"}', 'b')
      .run();
    expect((await outbox.claimDue(scope)).map((lease) => lease.id)).toEqual(['a', 'b']);
  } finally {
    await fixture.close();
  }
});
it('atomically admits unconditional outbox inserts and rolls back business writes on duplicate admission', async () => {
  const fixture = await setup();
  try {
    const business = sqliteTable('business', {
      id: text().primaryKey(),
      value: integer().notNull(),
    });
    await fixture.native
      .prepare(
        'CREATE TABLE business (id TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0))',
      )
      .run();
    const adapter = drizzleAdapter({ db: fixture.db, table: business, driver: 'd1' });
    const writes = requireAtomicBatch(adapter);
    const command = await prepareOutboxInsert({
      db: fixture.db,
      table: fixture.table,
      scope,
      input: { id: 'admission', payload: { value: 'event' } },
      parsePayload,
      admission: 'unconditional',
    });
    const [, admitted] = await executeAtomicBatch(adapter, [
      writes.create({ id: 'committed', value: 1 }),
      command,
    ]);
    expect(admitted.id).toBe('admission');
    await expect(
      executeAtomicBatch(adapter, [writes.create({ id: 'rollback', value: 2 }), command]),
    ).rejects.toThrow();
    expect(await fixture.db.select().from(business)).toEqual([{ id: 'committed', value: 1 }]);
    expect(await createOutbox({ store: fixture.store, parsePayload }).claimDue(scope)).toHaveLength(
      1,
    );
  } finally {
    await fixture.close();
  }
});
it('rejects conditional admission and fenced callback composition before any writes', async () => {
  const fixture = await setup();
  try {
    const batch = vi.spyOn(fixture.db, 'batch');
    await expect(
      prepareOutboxInsert({
        db: fixture.db,
        table: fixture.table,
        scope,
        input: { id: 'bad', payload: { value: 'x' } },
        parsePayload,
        admission: 'conditional' as 'unconditional',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(batch).not.toHaveBeenCalled();
    const inbox = createInbox({ store: fixture.store, parsePayload, consumer: 'consumer' });
    const lease = claimed(
      await inbox.claim(scope, { messageId: 'one', fingerprint: 'one', payload: { value: 'x' } }),
    );
    await expect(
      inbox.complete(lease, { transaction: {} as CrudTransactionScope }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect((await inbox.get(scope, 'one'))?.state).toBe('leased');
    expect(batch).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});
it('runs built root, HTTP and testing entrypoints in a native Worker without optional peer modules', async () => {
  const directory = new URL('../../packages/reliability/dist/', import.meta.url);
  const paths = await readdir(directory, { recursive: true });
  const entries = await Promise.all(
    paths
      .filter((path) => path.endsWith('.js') && !path.startsWith('drizzle/'))
      .map(
        async (path) =>
          [
            `reliability/${path}`,
            { type: 'esm' as const, contents: await readFile(new URL(path, directory), 'utf8') },
          ] as const,
      ),
  );
  const modules = Object.fromEntries(entries);
  expect(Object.keys(modules)).toContain('reliability/index.js');
  const worker = await runtime(
    `
    import { createIdempotency } from './reliability/index.js';
    import { createMemoryReliabilityStore } from './reliability/testing/index.js';
    import { captureHttpResult, parseHttpResult, replayHttpResult } from './reliability/http/index.js';
    export default { async fetch() {
      const service = createIdempotency({store:createMemoryReliabilityStore(),parseResult:parseHttpResult});
      const scope = {tenantId:'tenant',namespace:'worker'};
      const result = await service.claim(scope,{key:'one',fingerprint:'body'});
      if (result.kind !== 'claimed') throw new Error('Expected lease');
      await service.complete(result.claim,await captureHttpResult(new Response('portable',{status:201})));
      const replay = await service.claim(scope,{key:'one',fingerprint:'body'});
      if (replay.kind !== 'completed') throw new Error('Expected replay');
      return replayHttpResult(replay.value);
    } }`,
    modules,
  );
  try {
    const response = await worker.dispatchFetch('https://example.test');
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('portable');
  } finally {
    await worker.dispose();
  }
});
