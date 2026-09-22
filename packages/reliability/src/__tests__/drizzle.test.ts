import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle as libsql } from 'drizzle-orm/libsql';
import { drizzle as pglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, it } from 'vitest';
import { crudTransaction, withCrudTransactionStore } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import {
  createDrizzleReliabilityStore,
  reliabilitySqliteTable,
  reliabilityPgTable,
} from '../drizzle';
import {
  createInbox,
  createOutbox,
  ReliabilityClaimError,
  type ReliabilityStore,
  type ReliabilitySession,
} from '../index';
import { newRecord } from '../features';
import { contract, ddl, scope, parsePayload, claimed } from './support';

async function sqliteFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vela-delivery-'));
  const url = `file:${join(directory, 'records.db')}`;
  const clients = [createClient({ url }), createClient({ url })];
  const client = clients[0]!;
  const db = libsql(client);
  const table = reliabilitySqliteTable();
  await client.execute(ddl('reliability', 'sqlite'));
  await Promise.all(clients.map((connection) => connection.execute('PRAGMA busy_timeout = 5000')));
  const store = createDrizzleReliabilityStore({ db, table, dialect: 'sqlite' });
  return {
    store,
    db,
    client,
    table,
    other: createDrizzleReliabilityStore({ db: libsql(clients[1]!), table, dialect: 'sqlite' }),
    shift: async (ms: number) => {
      await client.execute({
        sql: 'UPDATE reliability SET available_at = max(0, available_at - ?), lease_until = max(0, lease_until - ?), expires_at = max(0, expires_at - ?)',
        args: [ms, ms, ms],
      });
    },
    reopen: async () => {
      const fresh = createClient({ url });
      clients.push(fresh);
      return createDrizzleReliabilityStore({ db: libsql(fresh), table, dialect: 'sqlite' });
    },
    close: async () => {
      for (const connection of clients) connection.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
contract('libsql independent connections', sqliteFixture);
contract('PostgreSQL SQL through PGlite', async () => {
  const client = new PGlite();
  const table = reliabilityPgTable();
  const db = pglite(client);
  await client.exec(ddl('reliability', 'pg'));
  const store = createDrizzleReliabilityStore({ db, table, dialect: 'pg' });
  return {
    store,
    other: createDrizzleReliabilityStore({ db: pglite(client), table, dialect: 'pg' }),
    shift: async (ms) => {
      await db.execute(
        sql`UPDATE reliability SET available_at = greatest(0, available_at - ${ms}), lease_until = lease_until - ${ms}, expires_at = expires_at - ${ms}`,
      );
    },
    reopen: async () => createDrizzleReliabilityStore({ db: pglite(client), table, dialect: 'pg' }),
    close: () => client.close(),
  };
});

it('commits outbox admission with business writes and rolls both back on caught errors', async () => {
  const fixture = await sqliteFixture();
  try {
    const business = sqliteTable('business', { id: text().primaryKey() });
    await fixture.client.execute('CREATE TABLE business (id TEXT PRIMARY KEY)');
    const adapter = drizzleAdapter({ db: fixture.db, table: business });
    const outbox = createOutbox({ store: fixture.store, parsePayload });
    const write = (id: string) =>
      crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
        await withCrudTransactionStore(
          transaction,
          fixture.store.transactionBinding,
          { tenantId: scope.tenantId },
          async (bound) => {
            // The native business adapter uses the same checked transaction through its own binding below.
            await createOutbox({ store: bound, parsePayload }).enqueue(scope, {
              id,
              payload: { value: id },
            });
          },
        );
        // Public adapter transaction is not reused here; business command joins via checked binding.
        const binding = (await import('@velajs/crud-drizzle')).drizzleTransactionStore(
          fixture.db,
          (run) => ({
            insert: () =>
              run(async (db) => {
                await db.insert(business).values({ id });
              }),
          }),
        );
        await withCrudTransactionStore(
          transaction,
          binding,
          { tenantId: scope.tenantId },
          (store) => store.insert(),
        );
        if (id === 'rollback')
          await outbox
            .enqueue(scope, { id, payload: { value: 'conflict' } }, { transaction })
            .catch(() => undefined);
      });
    await write('committed');
    await expect(write('rollback')).rejects.toThrow('rolled back');
    expect(await fixture.db.select().from(business)).toEqual([{ id: 'committed' }]);
    expect((await outbox.get(scope, 'committed'))?.state).toBe('pending');
    expect(await outbox.get(scope, 'rollback')).toBeNull();
  } finally {
    await fixture.close();
  }
});

it('rolls consumer writes back when an expired inbox fence error is caught', async () => {
  const fixture = await sqliteFixture();
  try {
    const business = sqliteTable('business', { id: text().primaryKey() });
    await fixture.client.execute('CREATE TABLE business (id TEXT PRIMARY KEY)');
    const adapter = drizzleAdapter({ db: fixture.db, table: business });
    const inbox = createInbox({ store: fixture.store, parsePayload, consumer: 'consumer' });
    const input = {
      messageId: 'one',
      fingerprint: 'one',
      payload: { value: 'payload' },
      leaseMs: 1000,
    };
    const stale = claimed(await inbox.claim(scope, input));
    await fixture.shift(2000);
    const current = claimed(await inbox.claim(scope, input));
    const { drizzleTransactionStore } = await import('@velajs/crud-drizzle');
    const binding = drizzleTransactionStore(fixture.db, (run) => ({
      insert: (id: string) =>
        run(async (db) => {
          await db.insert(business).values({ id });
        }),
    }));
    await expect(
      crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
        await withCrudTransactionStore(
          transaction,
          binding,
          { tenantId: scope.tenantId },
          (store) => store.insert('stale'),
        );
        await inbox.complete(stale, { transaction }).catch(() => undefined);
      }),
    ).rejects.toThrow('rolled back');
    expect(await fixture.db.select().from(business)).toEqual([]);
    await crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
      await withCrudTransactionStore(transaction, binding, { tenantId: scope.tenantId }, (store) =>
        store.insert('current'),
      );
      await inbox.complete(current, { transaction });
    });
    expect(await fixture.db.select().from(business)).toEqual([{ id: 'current' }]);
    expect((await inbox.claim(scope, input)).kind).toBe('completed');
  } finally {
    await fixture.close();
  }
});

it('rejects expired and foreign bindings and malformed persisted payloads', async () => {
  const fixture = await sqliteFixture();
  try {
    const adapter = drizzleAdapter({ db: fixture.db, table: fixture.table });
    let retained: ReturnType<typeof createOutbox<{ value: string }>> | undefined;
    await crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
      await withCrudTransactionStore(
        transaction,
        fixture.store.transactionBinding,
        { tenantId: scope.tenantId },
        async (bound) => {
          retained = createOutbox({ store: bound, parsePayload });
        },
      );
      await expect(
        createOutbox({ store: fixture.other, parsePayload }).enqueue(
          scope,
          { id: 'foreign', payload: { value: 'bad' } },
          { transaction },
        ),
      ).rejects.toThrow('Foreign');
    }).catch((error: unknown) => {
      expect(String(error)).toContain('rolled back');
    });
    await expect(
      retained!.enqueue(scope, { id: 'late', payload: { value: 'bad' } }),
    ).rejects.toThrow(/expired/i);
    const outbox = createOutbox({ store: fixture.store, parsePayload });
    await outbox.enqueue(scope, {
      id: 'a-valid',
      payload: { value: 'deliver-me' },
      maxAttempts: 1,
    });
    await outbox.enqueue(scope, { id: 'malformed', payload: { value: 'valid' } });
    await fixture.client.execute(
      "UPDATE reliability SET payload = '{\"value\":42}' WHERE id = 'malformed'",
    );
    await expect(outbox.claimDue(scope)).rejects.toThrow('Invalid payload');
    expect((await outbox.get(scope, 'malformed'))?.state).toBe('pending');
    expect(await outbox.get(scope, 'a-valid')).toMatchObject({ state: 'pending', attempt: 0 });
    await fixture.client.execute(
      'UPDATE reliability SET payload = \'{"value":"repaired"}\' WHERE id = \'malformed\'',
    );
    expect((await outbox.claimDue(scope)).map((lease) => lease.id)).toEqual([
      'a-valid',
      'malformed',
    ]);
  } finally {
    await fixture.close();
  }
});

it('reports known partial claims on unexpected native polling failure and recovers their leases', async () => {
  const fixture = await sqliteFixture();
  try {
    const normal = createOutbox({ store: fixture.store, parsePayload });
    await normal.enqueue(scope, { id: 'a', payload: { value: 'first' } });
    await normal.enqueue(scope, { id: 'b', payload: { value: 'second' } });
    const failing: ReliabilityStore = {
      run: (context, work) =>
        fixture.store.run(context, (session) => {
          let attempts = 0;
          return work({
            ...session,
            claim: async (...args) => {
              if (++attempts === 2) throw new Error('connection interrupted');
              return session.claim(...args);
            },
          });
        }),
    };
    let failure: unknown;
    try {
      await createOutbox({ store: failing, parsePayload }).claimDue(scope, { leaseMs: 1000 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ReliabilityClaimError);
    expect(failure).toMatchObject({
      committed: true,
      recoveryRequired: true,
      claims: [{ id: 'a' }],
    });
    expect(await normal.get(scope, 'a')).toMatchObject({ state: 'leased', attempt: 1 });
    expect(await normal.get(scope, 'b')).toMatchObject({ state: 'pending', attempt: 0 });
    await fixture.shift(2000);
    expect((await normal.claimDue(scope)).map((lease) => lease.id)).toEqual(['a', 'b']);
  } finally {
    await fixture.close();
  }
});

it('expires raw native sessions and rolls back caught or unawaited session mutations', async () => {
  const fixture = await sqliteFixture();
  try {
    const adapter = drizzleAdapter({ db: fixture.db, table: fixture.table });
    let retained: ReliabilitySession | undefined;
    await fixture.store.run(scope, async (session) => {
      retained = session;
    });
    await expect(retained!.now()).rejects.toThrow('Expired');
    const record = newRecord(scope, 'outbox', 'unawaited', '{"value":"one"}', 'digest', Date.now());
    await expect(
      crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
        await fixture.store.run(
          scope,
          async (session) => {
            void session.insert(record);
          },
          transaction,
        );
      }),
    ).rejects.toThrow('Unawaited');
    expect(
      await createOutbox({ store: fixture.store, parsePayload }).get(scope, record.id),
    ).toBeNull();
    await expect(
      crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
        await fixture.store
          .run(
            scope,
            async (session) => {
              await session.insert(record);
              await session.get({ ...record, tenantId: 'another' }).catch(() => undefined);
            },
            transaction,
          )
          .catch(() => undefined);
      }),
    ).rejects.toThrow('rolled back');
    expect(
      await createOutbox({ store: fixture.store, parsePayload }).get(scope, record.id),
    ).toBeNull();
  } finally {
    await fixture.close();
  }
});
