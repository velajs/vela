import { afterAll, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import {
  createCrudDatabaseRegistry,
  crudTransaction,
  defineCrudDatabase,
  defineModel,
  withCrudTransactionStore,
} from '@velajs/crud';
import { drizzleAdapter, drizzleTransactionStore } from '@velajs/crud-drizzle';

const directory = await mkdtemp(join(tmpdir(), 'vela-store-registration-'));
const client = createClient({ url: `file:${join(directory, 'test.db')}` });
const db = drizzle(client);
const rows = sqliteTable('registration_store', { id: text().primaryKey() });
const model = defineModel({
  name: 'item',
  tableName: 'registration_store',
  schema: z.object({ id: z.string() }),
  id: 'client',
  timestamps: false,
});
await client.execute('CREATE TABLE registration_store(id TEXT PRIMARY KEY)');
beforeEach(async () => {
  await client.execute('DELETE FROM registration_store');
});
afterAll(async () => {
  client.close();
  await rm(directory, { recursive: true, force: true });
});
const native = drizzleAdapter({ db, table: rows });
const registry = createCrudDatabaseRegistry([
  defineCrudDatabase('main', { handle: db, resources: { item: { model, adapter: native } } }),
]);
const source = drizzleTransactionStore(db, (run, context) => ({
  insert: (id: string) =>
    run(async (tx) => {
      await tx.insert(rows).values({ id: `${context.tenantId}:${id}` });
    }),
  fail: () =>
    run(async () => {
      throw new Error('stale lease');
    }),
}));

it('joins native stores through an application registration and rejects another registration', async () => {
  const one = registry.forApplication();
  const two = registry.forApplication();
  const adapter = one.resolve('main').resources.item!.adapter;
  const binding = one.bindTransactionStore('main', source);
  let escaped: ReturnType<typeof source.bind> | undefined;
  await crudTransaction(adapter, { tenantId: 'a' }, async (transaction) => {
    await withCrudTransactionStore(transaction, binding, { tenantId: 'a' }, async (store) => {
      escaped = store;
      await store.insert('committed');
    });
  });
  expect(await db.select().from(rows)).toEqual([{ id: 'a:committed' }]);
  await expect(async () => escaped!.insert('late')).rejects.toThrow(/expired/i);
  await expect(
    crudTransaction(adapter, { tenantId: 'a' }, (transaction) =>
      withCrudTransactionStore(
        transaction,
        two.bindTransactionStore('main', source),
        { tenantId: 'a' },
        async (store) => store.insert('foreign'),
      ),
    ),
  ).rejects.toThrow('Foreign');
  expect(() => one.bindTransactionStore('main', two.bindTransactionStore('main', source))).toThrow(
    'Foreign',
  );
});

it('preserves failure poisoning through the registration wrapper when a caller catches a fenced miss', async () => {
  const application = registry.forApplication();
  const adapter = application.resolve('main').resources.item!.adapter;
  const binding = application.bindTransactionStore('main', source);
  await expect(
    crudTransaction(adapter, { tenantId: 'b' }, async (transaction) => {
      await withCrudTransactionStore(transaction, binding, { tenantId: 'b' }, async (store) => {
        await store.insert('rolled-back');
        await store.fail().catch(() => undefined);
      });
    }),
  ).rejects.toThrow('rolled back');
  expect(await db.select().from(rows)).toEqual([]);
});

it('forwards writable state and private setters without replacing transaction ownership', () => {
  class Store {
    #enabled = true;
    label = 'initial';
    readonly transaction = drizzleTransactionStore(db, () => this);
    get enabled() {
      return this.#enabled;
    }
    set enabled(value: boolean) {
      this.#enabled = value;
    }
  }
  const original = new Store();
  const application = registry.forApplication();
  const bound = application.bindStore('main', original);
  const transaction = bound.transaction;
  bound.enabled = false;
  bound.label = 'changed';
  expect([bound.enabled, original.enabled, bound.label, original.label]).toEqual([
    false,
    false,
    'changed',
    'changed',
  ]);
  Object.defineProperty(bound, 'label', { value: 'defined', configurable: true });
  expect([bound.label, original.label]).toEqual(['defined', 'defined']);
  expect(Reflect.deleteProperty(bound, 'label')).toBe(true);
  expect('label' in original).toBe(false);
  expect('label' in bound).toBe(false);
  expect(Reflect.set(bound, 'transaction', original.transaction)).toBe(false);
  expect(Reflect.deleteProperty(bound, 'transaction')).toBe(false);
  expect(Reflect.defineProperty(bound, 'transaction', { value: original.transaction })).toBe(false);
  expect(Object.getOwnPropertyDescriptor(bound, 'transaction')?.value).toBe(transaction);
  expect(bound.transaction).toBe(transaction);
  expect(Reflect.preventExtensions(bound)).toBe(false);
  expect(() => Object.keys(bound)).not.toThrow();
  const frozen = application.bindStore('main', Object.freeze(new Store()));
  expect(Reflect.set(frozen, 'label', 'changed')).toBe(false);
  expect(frozen.label).toBe('initial');
});
