import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle as sqlite } from 'drizzle-orm/libsql';
import { drizzle as d1 } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Miniflare } from 'miniflare';
import { z } from 'zod';
import {
  defineModel,
  defineResource,
  executeAtomicBatch,
  requireAtomicBatch,
  AtomicBatchResultError,
  CrudDatabaseRegistry,
  defineCrudDatabase,
} from '@velajs/crud';
import type { AtomicCommand, CrudAdapter } from '@velajs/crud/adapter';
import { MemoryAuditStore } from '@velajs/crud/audit';
import { drizzleAdapter, DrizzleAuditStore } from '@velajs/crud-drizzle';

const items = sqliteTable('items', {
  id: text().primaryKey(),
  value: integer().notNull(),
  tenantId: text().notNull(),
  deletedAt: integer(),
});
const related = sqliteTable('related', { id: text().primaryKey(), value: integer().notNull() });
const audit = sqliteTable('audit', {
  id: text().primaryKey(),
  timestamp: integer().notNull(),
  action: text().notNull(),
  tableName: text().notNull(),
  recordId: text().notNull(),
  userId: text(),
  record: text(),
  previousRecord: text(),
  changes: text(),
  metadata: text(),
});
const schema = z.object({
  id: z.string(),
  value: z.number(),
  tenantId: z.string(),
  deletedAt: z.number().nullable(),
});
type Item = z.infer<typeof schema>;
const model = defineModel({
  name: 'item',
  tableName: 'items',
  schema,
  id: 'client',
  timestamps: false,
  multiTenant: true,
  softDelete: true,
  audit: true,
});
const directory = await mkdtemp(join(tmpdir(), 'vela-atomic-'));
const client = createClient({ url: `file:${join(directory, 'test.db')}` });
const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'atomic-d1',
        type: 'worker',
        compatibilityDate: '2026-09-20',
        manifest: {
          mainModule: 'worker.js',
          modules: {
            'worker.js': {
              type: 'esm',
              contents: 'export default { fetch(){return new Response("ok")} }',
            },
          },
        },
        env: { DB: { type: 'd1', id: 'atomic-d1' } },
      },
    },
  ],
});
const nativeD1 = await runtime.getD1Database('DB');
const databases = [
  {
    name: 'libsql',
    db: sqlite(client),
    driver: 'transactional' as const,
    exec: async (sql: string) => {
      await client.execute(sql);
    },
  },
  {
    name: 'workerd D1',
    db: d1(nativeD1),
    driver: 'd1' as const,
    exec: async (sql: string) => {
      await nativeD1.exec(sql);
    },
  },
];
afterAll(async () => {
  client.close();
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
});
for (const database of databases)
  describe(database.name, () => {
    const { db, exec } = database;
    const make = () =>
      database.driver === 'd1'
        ? drizzleAdapter({
            db: database.db,
            driver: 'd1',
            table: items,
            softDeleteField: 'deletedAt',
            parseRow: (v) => schema.parse(v),
          })
        : drizzleAdapter({
            db: database.db,
            table: items,
            softDeleteField: 'deletedAt',
            parseRow: (v) => schema.parse(v),
          });
    const adapter = make();
    const batch = requireAtomicBatch(adapter);
    const other =
      database.driver === 'd1'
        ? drizzleAdapter({ db: database.db, driver: 'd1', table: related })
        : drizzleAdapter({ db: database.db, table: related });
    const logs = new DrizzleAuditStore(db, audit);
    const note = (id: string, recordId = 'one') =>
      logs.atomic.prepare({
        id,
        timestamp: new Date(),
        action: 'update',
        tableName: 'items',
        recordId,
      });
    const key = (id = 'one', tenant = 'a') => ({
      field: 'id',
      value: id,
      filters: { tenantId: tenant },
    });
    const item = (id = 'one', value = 1) => ({ id, value, tenantId: 'a', deletedAt: null });
    const resource = () =>
      defineResource('items', {
        model,
        adapter,
        auditStore: logs,
        auditPersistence: { mode: 'atomic', snapshots: 'none' },
      });
    beforeAll(async () => {
      await exec(
        'CREATE TABLE items (id TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0), tenantId TEXT NOT NULL, deletedAt INTEGER)',
      );
      await exec(
        'CREATE TABLE related (id TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0))',
      );
      await exec(
        'CREATE TABLE audit (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, action TEXT NOT NULL, tableName TEXT NOT NULL, recordId TEXT NOT NULL, userId TEXT, record TEXT, previousRecord TEXT, changes TEXT, metadata TEXT)',
      );
    });
    beforeEach(async () => {
      await exec('DELETE FROM items');
      await exec('DELETE FROM related');
      await exec('DELETE FROM audit');
    });
    it('commits related writes with positional typed results and an attached audit', async () => {
      const commands = [
        batch.create(item(), { audit: note('log') }),
        requireAtomicBatch(other).create({ id: 'two', value: 2 }),
      ] as const;
      const result = await executeAtomicBatch(adapter, commands);
      expectTypeOf(result[0]).toEqualTypeOf<Item>();
      expect(result[0]).toEqual(item());
      expect(result[1]).toEqual({ id: 'two', value: 2 });
      expect(await logs.query()).toHaveLength(1);
      expect(adapter.capabilities.has('atomicBatch')).toBe(true);
      expect(adapter.capabilities.has('transactions')).toBe(database.driver !== 'd1');
    });
    it('rolls back prior writes AND audit inserts when a later command violates a constraint', async () => {
      await expect(
        batch.execute([
          batch.create(item(), { audit: note('log') }),
          requireAtomicBatch(other).create({ id: 'bad', value: -1 }),
        ]),
      ).rejects.toThrow();
      expect(await db.select().from(items)).toEqual([]);
      expect(await db.select().from(related)).toEqual([]);
      expect(await logs.query()).toEqual([]);
    });
    it('rolls back all preceding writes when audit persistence fails', async () => {
      await logs.log({
        id: 'duplicate',
        timestamp: new Date(),
        action: 'create',
        tableName: 'items',
        recordId: 'existing',
      });
      await expect(
        batch.execute([
          requireAtomicBatch(other).create({ id: 'two', value: 2 }),
          batch.create(item(), { audit: note('duplicate') }),
        ]),
      ).rejects.toThrow();
      expect(await db.select().from(items)).toEqual([]);
      expect(await db.select().from(related)).toEqual([]);
      expect((await logs.query()).map((x) => x.recordId)).toEqual(['existing']);
    });
    it('conditionally skips both mutation and its audit, including after a successful write', async () => {
      const [created, miss, deleted] = await batch.execute([
        batch.create(item()),
        batch.update(key('one', 'b'), { value: 9 }, { audit: note('miss') }),
        batch.delete(key('missing'), {}, { audit: note('delete-miss') }),
      ]);
      expectTypeOf(miss).toEqualTypeOf<Item | null>();
      expect(created.value).toBe(1);
      expect(miss).toBeNull();
      expect(deleted).toBeNull();
      expect(await logs.query()).toEqual([]);
      expect((await db.select().from(items))[0]!.value).toBe(1);
    });
    it('enforces structured predicates in SQL and commits audited update/delete', async () => {
      await batch.execute([batch.create(item())]);
      expect(
        await batch.execute([
          batch.update(
            { ...key(), predicate: { op: 'eq', field: 'value', value: 99 } },
            { value: 2 },
            { audit: note('no') },
          ),
        ]),
      ).toEqual([null]);
      const [updated, deleted] = await batch.execute([
        batch.update(key(), { value: 3 }, { audit: note('yes') }),
        batch.delete(key(), {}, { audit: note('removed') }),
      ]);
      expect(updated?.value).toBe(3);
      expect(deleted?.value).toBe(3);
      expect(await db.select().from(items)).toEqual([]);
      expect(await logs.query()).toHaveLength(2);
    });
    it('rejects forged and foreign commands, even in a later slot, before effects', async () => {
      await expect(batch.execute([batch.create(item()), {} as AtomicCommand])).rejects.toThrow(
        'fabricated',
      );
      const foreignClient = createClient({ url: 'file::memory:' });
      try {
        const foreign = drizzleAdapter({
          db: sqlite(foreignClient),
          table: items,
          transactionOwner: db,
        });
        await expect(
          batch.execute([
            batch.create(item()),
            requireAtomicBatch(foreign).create(item('foreign')),
          ]),
        ).rejects.toThrow('Foreign');
        const foreignAudit = new DrizzleAuditStore(sqlite(foreignClient), audit);
        expect(() =>
          batch.create(item(), {
            audit: foreignAudit.atomic.prepare({
              id: 'x',
              timestamp: new Date(),
              action: 'create',
              tableName: 'items',
              recordId: 'x',
            }),
          }),
        ).toThrow('Foreign');
      } finally {
        foreignClient.close();
      }
      expect(await db.select().from(items)).toEqual([]);
    });
    it('snapshots author input and requires a full primary-key lookup', async () => {
      const input = item();
      const command = batch.create(input);
      input.value = 99;
      expect((await batch.execute([command]))[0].value).toBe(1);
      expect(() => batch.update({ field: 'tenantId', value: 'a' }, { value: 3 })).toThrow(
        'primary-key',
      );
    });
    it('implements metadata-only atomic auditing with tenant and authorization predicates', async () => {
      const scoped = defineResource('items', {
        model,
        adapter,
        auditStore: logs,
        auditPersistence: { mode: 'atomic', snapshots: 'none' },
        authorization: () => ({
          kind: 'conditional',
          predicate: { op: 'gte', field: 'value', value: 1 },
        }),
      });
      await scoped.execute('create', {
        body: { id: 'one', value: 1 },
        vars: { tenantId: 'a', userId: 'actor' },
      });
      await expect(
        scoped.execute('update', { id: 'one', body: { value: 5 }, vars: { tenantId: 'b' } }),
      ).rejects.toThrow();
      await scoped.execute('update', { id: 'one', body: { value: 2 }, vars: { tenantId: 'a' } });
      await scoped.execute('delete', { id: 'one', vars: { tenantId: 'a' } });
      const entries = await logs.query();
      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        expect(entry.record).toBeUndefined();
        expect(entry.previousRecord).toBeUndefined();
        expect(entry.changes).toBeUndefined();
        expect(entry.metadata).toEqual({ snapshots: 'none', tenantId: 'a' });
      }
      expect((await db.select().from(items))[0]!.deletedAt).toBeTypeOf('number');
    });
    it('rolls back an audited CRUD create if its audit insert fails and emits no commit event', async () => {
      await exec(
        "CREATE TRIGGER reject_atomic_audit BEFORE INSERT ON audit WHEN NEW.recordId = 'reject' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
      );
      const afterCommit = vi.fn();
      try {
        const scoped = defineResource('items', {
          model,
          adapter,
          auditStore: logs,
          auditPersistence: { mode: 'atomic', snapshots: 'none' },
          afterCommit,
        });
        await expect(
          scoped.execute('create', { body: { id: 'reject', value: 1 }, vars: { tenantId: 'a' } }),
        ).rejects.toThrow();
        expect(await db.select().from(items)).toEqual([]);
        expect(await logs.query()).toEqual([]);
        expect(afterCommit).not.toHaveBeenCalled();
      } finally {
        await exec('DROP TRIGGER reject_atomic_audit');
      }
    });
    it('rejects unsupported stores, snapshots and hooks before effects', async () => {
      expect(() =>
        defineResource('items', {
          model,
          adapter,
          auditStore: logs,
          auditPersistence: { mode: 'atomic', snapshots: 'previous' as 'none' },
        }),
      ).toThrow('snapshots: none');
      expect(() =>
        defineResource('items', {
          model,
          adapter,
          auditStore: new MemoryAuditStore(),
          auditPersistence: { mode: 'atomic', snapshots: 'none' },
        }),
      ).toThrow('same native database');
      expect(() =>
        defineResource('items', {
          model,
          adapter,
          auditStore: logs,
          auditPersistence: { mode: 'atomic', snapshots: 'none' },
          hooks: { beforeUpdate: () => {} },
        }),
      ).toThrow('mutation hooks');
      await expect(
        resource().execute('batchCreate', { body: { items: [item()] }, vars: { tenantId: 'a' } }),
      ).rejects.toThrow('does not support');
      expect(await db.select().from(items)).toEqual([]);
    });
    it('supports named database registrations and reports post-commit event failures without rollback', async () => {
      const registry = new CrudDatabaseRegistry([
        defineCrudDatabase('main', {
          handle: db,
          resources: { item: { model, adapter } },
          auditStore: logs,
        }),
      ]).forApplication();
      const registered = registry.resolve('main');
      const failure = vi.fn();
      const afterCommit = vi.fn(() => {
        throw new Error('delivery failed');
      });
      const scoped = defineResource('items', {
        model,
        adapter: registered.resources.item!.adapter,
        auditStore: registered.auditStore,
        auditPersistence: { mode: 'atomic', snapshots: 'none' },
        afterCommit,
        onAfterCommitError: failure,
      });
      expect(
        (await scoped.execute('create', { body: { id: 'one', value: 1 }, vars: { tenantId: 'a' } }))
          .status,
      ).toBe(201);
      expect(await logs.query()).toHaveLength(1);
      expect(await db.select().from(items)).toHaveLength(1);
      expect(afterCommit).toHaveBeenCalledOnce();
      expect(failure).toHaveBeenCalledOnce();
    });
    it('validates typed results before SQL commit, and marks D1 decode errors as committed', async () => {
      const bad =
        database.driver === 'd1'
          ? drizzleAdapter({
              db: database.db,
              driver: 'd1',
              table: items,
              parseRow: () => {
                throw new Error('bad row');
              },
            })
          : drizzleAdapter({
              db: database.db,
              table: items,
              parseRow: () => {
                throw new Error('bad row');
              },
            });
      const operation = requireAtomicBatch(bad).execute([requireAtomicBatch(bad).create(item())]);
      if (database.driver === 'd1') {
        await expect(operation).rejects.toBeInstanceOf(AtomicBatchResultError);
        expect(await db.select().from(items)).toHaveLength(1);
      } else {
        await expect(operation).rejects.toThrow('bad row');
        expect(await db.select().from(items)).toEqual([]);
      }
    });
    it('rejects undeclared capability at runtime', () => {
      const unsupported: CrudAdapter = {
        ...adapter,
        runtime: { ...adapter.runtime, capabilities: new Set() },
        capabilities: new Set(),
      };
      expect(() => requireAtomicBatch(unsupported)).toThrow('does not support');
    });
    if (database.driver === 'd1')
      it('prepares and bounds every statement before the single D1 batch', async () => {
        const native = vi.spyOn(database.db, 'batch');
        const transaction = vi.spyOn(database.db, 'transaction');
        const predicate = {
          op: 'in' as const,
          field: 'value',
          values: Array.from({ length: 101 }, (_, i) => i),
        };
        await expect(
          batch.execute([
            batch.create(item()),
            batch.update({ ...key(), predicate }, { value: 3 }),
          ]),
        ).rejects.toMatchObject({ code: 'QUERY_PARAMETER_LIMIT' });
        expect(native).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        expect(await db.select().from(items)).toEqual([]);
        await batch.execute([
          batch.create(item()),
          batch.update(key(), { value: 2 }, { audit: note('ok') }),
        ]);
        expect(native).toHaveBeenCalledOnce();
        expect(transaction).not.toHaveBeenCalled();
        native.mockRestore();
        transaction.mockRestore();
      });
  });

describe('atomic batch boundary validation', () => {
  it('treats an empty batch as a no-op and rejects malformed arrays before opening a transaction', async () => {
    const db = sqlite(client);
    const adapter = drizzleAdapter({ db, table: items });
    const batch = requireAtomicBatch(adapter);
    const transaction = vi.spyOn(db, 'transaction');
    expect(await batch.execute([])).toEqual([]);
    await expect(batch.execute(null as unknown as AtomicCommand[])).rejects.toThrow(
      'command array',
    );
    await expect(batch.execute(new Array<AtomicCommand>(1))).rejects.toThrow('fabricated');
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });
  it('rejects different context initializers before opening the shared SQL transaction', async () => {
    const db = sqlite(client);
    const adapter = drizzleAdapter({ db, table: items });
    const open = vi.fn();
    const second = drizzleAdapter({ db, table: related, onOpenTransaction: open });
    const transaction = vi.spyOn(db, 'transaction');
    await expect(
      requireAtomicBatch(adapter).execute([
        requireAtomicBatch(second).create({ id: 'two', value: 2 }),
      ]),
    ).rejects.toThrow('same transaction context');
    expect(transaction).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    transaction.mockRestore();
  });
  it('evaluates D1 runtime defaults exactly once for the statements sent to batch', async () => {
    let evaluations = 0;
    const defaults = sqliteTable('defaults', {
      id: text().primaryKey(),
      value: integer().$defaultFn(() => ++evaluations),
    });
    await nativeD1.exec('CREATE TABLE defaults (id TEXT PRIMARY KEY, value INTEGER)');
    const db = d1(nativeD1);
    const adapter = drizzleAdapter({ db, driver: 'd1', table: defaults });
    const batch = requireAtomicBatch(adapter);
    const [row] = await batch.execute([batch.create({ id: 'one' })]);
    expect(evaluations).toBe(1);
    expect(row.value).toBe(1);
    expect(await db.select().from(defaults)).toEqual([{ id: 'one', value: 1 }]);
  });
});

it('does not advertise async atomic batches for synchronous SQLite handles', () => {
  const db = sqlite(client);
  const synchronous = Object.create(db) as typeof db;
  Object.defineProperty(synchronous, 'resultKind', { value: 'sync' });
  const adapter = drizzleAdapter({ db: synchronous, table: items });
  expect(adapter.capabilities.has('atomicBatch')).toBe(false);
  expect(adapter.atomicBatch).toBeUndefined();
  expect(() => requireAtomicBatch(adapter)).toThrow('does not support');
});
