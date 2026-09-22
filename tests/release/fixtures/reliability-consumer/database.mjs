import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import {
  createCrudDatabaseRegistry,
  defineCrudDatabase,
  defineModel,
  defineResource,
  crudTransaction,
  withCrudTransactionStore,
} from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { createIdempotency, createOutbox, createInbox } from '@velajs/reliability';
import { createDrizzleReliabilityStore, reliabilitySqliteTable } from '@velajs/reliability/drizzle';

const url = new URL('./delivery.db', import.meta.url).href;
const clients = [createClient({ url }), createClient({ url })];
const scope = { tenantId: 'verified-tenant', namespace: 'consumer' };
const parsePayload = (value) => z.object({ value: z.string() }).parse(value);
try {
  await clients[0].executeMultiple(`
    CREATE TABLE business (id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE reliability (
      tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      generation TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
      token TEXT, fence INTEGER NOT NULL, revision INTEGER NOT NULL, attempt INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL, available_at INTEGER NOT NULL, lease_until INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, retention_ms INTEGER NOT NULL,
      expires_at INTEGER, result TEXT, error TEXT, PRIMARY KEY(tenant_id,namespace,kind,id)
    );
  `);
  for (const client of clients) await client.execute('PRAGMA busy_timeout = 5000');
  const db = drizzle(clients[0]);
  const table = reliabilitySqliteTable();
  const stores = [db, drizzle(clients[1])].map((database) =>
    createDrizzleReliabilityStore({ db: database, table, dialect: 'sqlite' }),
  );
  const idempotency = stores.map((store) =>
    createIdempotency({ store, parseResult: parsePayload }),
  );
  const input = { key: 'request', fingerprint: 'body', leaseMs: 60_000 };
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => idempotency[index % 2].claim(scope, input)),
  );
  assert.equal(results.filter((result) => result.kind === 'claimed').length, 1);
  await idempotency[0].complete(results.find((result) => result.kind === 'claimed').claim, {
    value: 'saved',
  });
  const business = sqliteTable('business', {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    value: text().notNull(),
  });
  const model = defineModel({
    name: 'item',
    tableName: 'business',
    multiTenant: true,
    timestamps: false,
    id: 'client',
    schema: z.object({ id: z.string(), tenantId: z.string(), value: z.string() }),
  });
  const native = drizzleAdapter({ db, table: business });
  const registry = createCrudDatabaseRegistry([
    defineCrudDatabase('main', { handle: db, resources: { item: { model, adapter: native } } }),
  ]).forApplication();
  const adapter = registry.resolve('main').resources.item.adapter;
  const resource = defineResource('items', { model, adapter });
  const binding = registry.bindTransactionStore('main', stores[0].transactionBinding);
  const write = (id, abort) =>
    crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
      await resource.execute('create', {
        transaction,
        vars: { tenantId: scope.tenantId },
        body: { id, value: id },
      });
      await withCrudTransactionStore(
        transaction,
        binding,
        { tenantId: scope.tenantId },
        async (store) => {
          await createOutbox({ store, parsePayload }).enqueue(scope, {
            id,
            payload: { value: id },
          });
        },
      );
      if (abort) throw new Error('rollback');
    });
  await assert.rejects(write('rollback', true), /rollback/);
  assert.deepEqual(await db.select().from(business), []);
  assert.equal(await createOutbox({ store: stores[0], parsePayload }).get(scope, 'rollback'), null);
  await write('committed', false);
  clients[1].close();
  clients[1] = createClient({ url });
  const restarted = createDrizzleReliabilityStore({
    db: drizzle(clients[1]),
    table,
    dialect: 'sqlite',
  });
  assert.deepEqual(
    await createIdempotency({ store: restarted, parseResult: parsePayload }).claim(scope, input),
    { kind: 'completed', value: { value: 'saved' } },
  );
  const outbox = createOutbox({ store: restarted, parsePayload });
  const [delivery] = await outbox.claimDue(scope);
  assert.equal(delivery.id, 'committed');
  const inbox = createInbox({ store: stores[0], parsePayload, consumer: 'processor' });
  const message = {
    messageId: delivery.id,
    payload: delivery.payload,
    fingerprint: 'message-body',
  };
  const claim = await inbox.claim(scope, message);
  await assert.rejects(
    crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
      await resource.execute('create', {
        transaction,
        vars: { tenantId: scope.tenantId },
        body: { id: 'consumer-rollback', value: 'discarded' },
      });
      await withCrudTransactionStore(
        transaction,
        binding,
        { tenantId: scope.tenantId },
        async (store) => {
          await createInbox({ store, parsePayload, consumer: 'processor' }).complete(claim.claim);
        },
      );
      throw new Error('consumer rollback');
    }),
    /consumer rollback/,
  );
  assert.equal((await inbox.claim(scope, message)).kind, 'busy');
  await crudTransaction(adapter, { tenantId: scope.tenantId }, async (transaction) => {
    await resource.execute('create', {
      transaction,
      vars: { tenantId: scope.tenantId },
      body: { id: 'consumed', value: delivery.payload.value },
    });
    await withCrudTransactionStore(
      transaction,
      binding,
      { tenantId: scope.tenantId },
      async (store) => {
        await createInbox({ store, parsePayload, consumer: 'processor' }).complete(claim.claim);
      },
    );
  });
  await outbox.acknowledge(delivery);
  assert.equal((await inbox.claim(scope, message)).kind, 'completed');
  assert.deepEqual((await db.select().from(business)).map((row) => row.id).sort(), [
    'committed',
    'consumed',
  ]);
} finally {
  for (const client of clients) client.close();
}
