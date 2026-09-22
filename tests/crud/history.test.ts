import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { defineModel, defineResource } from '@velajs/crud';
import { MemoryAuditStore } from '@velajs/crud/audit';
import { MemoryVersioningStore, historyTenantNamespace } from '@velajs/crud/versioning';
import { MemoryStore, transactionalMemoryAdapter, memoryAdapter } from '@velajs/crud-memory';
import {
  transactionalMemoryAuditStore,
  transactionalMemoryVersioningStore,
} from '../../packages/crud-memory/src/history';
import {
  crudTransaction,
  withCrudTransactionStore,
} from '../../packages/crud/src/kernel/transaction';
import { drizzleTransactionStore } from '../../packages/crud-drizzle/src/transaction';
import { drizzleAdapter, DrizzleAuditStore, DrizzleVersioningStore } from '@velajs/crud-drizzle';

const items = sqliteTable('items', {
  id: text().primaryKey(),
  title: text().notNull(),
  version: integer(),
  tenantId: text().notNull(),
  deletedAt: integer(),
});
const versions = sqliteTable(
  'versions',
  {
    id: text().primaryKey(),
    tableName: text().notNull(),
    recordId: text().notNull(),
    version: integer().notNull(),
    data: text().notNull(),
    createdAt: integer().notNull(),
    changedBy: text(),
    changeReason: text(),
  },
  (t) => [uniqueIndex('version_identity').on(t.tableName, t.recordId, t.version)],
);
const audits = sqliteTable('audits', {
  id: text().primaryKey(),
  tenantNamespace: text(),
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
const model = defineModel({
  name: 'item',
  tableName: 'items',
  id: 'client',
  timestamps: false,
  multiTenant: true,
  softDelete: true,
  versioning: true,
  audit: true,
  schema: z.object({
    id: z.string(),
    title: z.string(),
    version: z.number().optional(),
    tenantId: z.string(),
    deletedAt: z.number().nullable().optional(),
  }),
});
const vars = { tenantId: 'tenant-a', userId: 'operator' };
const namespace = historyTenantNamespace(vars.tenantId);
const key = (id = 'one') => ({
  tenantNamespace: namespace,
  primaryKey: JSON.stringify([['id', 'string', id]]),
});

async function fixture(kind: 'memory' | 'sqlite') {
  const root = new MemoryStore();
  const directory = kind === 'sqlite' ? mkdtempSync(join(tmpdir(), 'vela-history-')) : undefined;
  const client = directory
    ? createClient({ url: `file:${join(directory, 'database.db')}` })
    : undefined;
  const db = client ? drizzle(client) : undefined;
  if (client)
    await client.executeMultiple(`
    CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(title <> 'invalid'), version INTEGER, tenantId TEXT NOT NULL, deletedAt INTEGER);
    CREATE TABLE versions (id TEXT PRIMARY KEY, tableName TEXT NOT NULL, recordId TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL, changedBy TEXT, changeReason TEXT);
    CREATE UNIQUE INDEX version_identity ON versions(tableName, recordId, version);
    CREATE TABLE audits (id TEXT PRIMARY KEY, tenantNamespace TEXT, timestamp INTEGER NOT NULL, action TEXT NOT NULL, tableName TEXT NOT NULL, recordId TEXT NOT NULL, userId TEXT, record TEXT, previousRecord TEXT, changes TEXT, metadata TEXT);
  `);
  const adapter = db
    ? drizzleAdapter({ db, table: items, softDeleteField: 'deletedAt', atomicUpsert: true })
    : transactionalMemoryAdapter({ store: root, tableName: 'items', softDeleteField: 'deletedAt' });
  const history = db
    ? new DrizzleVersioningStore(db, versions)
    : transactionalMemoryVersioningStore(root);
  const audit = db ? new DrizzleAuditStore(db, audits) : transactionalMemoryAuditStore(root);
  const config = {
    model,
    adapter,
    versioningStore: history,
    auditStore: audit,
    auditPersistence: { mode: 'transaction' as const },
    filterFields: ['title'],
    upsert: { keys: ['id'] },
  };
  const resource = defineResource('items', config);
  await resource.execute('create', { body: { id: 'one', title: 'original', version: 999 }, vars });
  return {
    adapter,
    history,
    audit,
    config,
    resource,
    client,
    db,
    async row() {
      return adapter.requestScope((scope) =>
        adapter.readOne({ field: 'id', value: 'one' }, { withDeleted: true }, scope),
      );
    },
    close() {
      client?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe.each(['memory', 'sqlite'] as const)('%s transactional history', (kind) => {
  it('rolls back row, snapshots and audit on a failed hook or later composed operation', async () => {
    const f = await fixture(kind);
    try {
      expect((await f.row())?.version).toBe(1);
      const failing = defineResource('failing', {
        ...f.config,
        hooks: {
          afterUpdate() {
            throw new Error('hook failed');
          },
        },
      });
      await expect(
        failing.execute('update', { id: 'one', body: { title: 'changed' }, vars }),
      ).rejects.toThrow('hook failed');
      expect((await f.row())?.title).toBe('original');
      expect(await f.history.list('items', key())).toEqual([]);
      expect(await f.audit.query({ tenantNamespace: namespace })).toHaveLength(1);
      await expect(
        crudTransaction(f.adapter, vars, async (transaction) => {
          await f.resource.execute('update', {
            transaction,
            id: 'one',
            body: { title: 'changed' },
            vars,
          });
          await f.resource.execute('create', {
            transaction,
            body: { id: 'two', title: 'second' },
            vars,
          });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await f.row())?.title).toBe('original');
      expect(await f.history.list('items', key())).toEqual([]);
      expect(await f.audit.query({ tenantNamespace: namespace })).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it('commits history in a composed transaction and reads its own snapshots', async () => {
    const f = await fixture(kind);
    try {
      await crudTransaction(f.adapter, vars, async (transaction) => {
        await f.resource.execute('update', {
          transaction,
          id: 'one',
          body: { title: 'second' },
          vars,
        });
        const result = await f.resource.execute('versionRead', {
          transaction,
          id: 'one',
          params: { version: '1' },
          vars,
        });
        expect(result.body).toMatchObject({ result: { data: { title: 'original' } } });
        await withCrudTransactionStore(transaction, f.history.transaction!, vars, async (store) => {
          expect(await store.latest('items', key())).toBe(1);
          expect(await store.list('items', key())).toHaveLength(1);
          expect((await store.get('items', key(), 1))?.data.title).toBe('original');
        });
        await withCrudTransactionStore(transaction, f.audit.transaction!, vars, async (store) => {
          expect(await store.query()).toHaveLength(2);
        });
      });
      await f.resource.execute('versionRollback', { id: 'one', params: { version: '1' }, vars });
      expect(await f.row()).toMatchObject({ title: 'original', version: 3 });
      expect((await f.history.list('items', key())).map((v) => v.version)).toEqual([2, 1]);
      expect(await f.audit.query({ tenantNamespace: namespace })).toHaveLength(3);
    } finally {
      f.close();
    }
  });

  it('captures batch updates, upserts and soft-delete/restore without duplicate versions', async () => {
    const f = await fixture(kind);
    try {
      await f.resource.execute('batchUpdate', {
        body: { items: [{ id: 'one', data: { title: 'batch' } }] },
        vars,
      });
      await f.resource.execute('upsert', { body: { id: 'one', title: 'upsert' }, vars });
      await f.resource.execute('delete', { id: 'one', vars });
      await f.resource.execute('restore', { id: 'one', vars });
      expect(await f.row()).toMatchObject({ version: 5, title: 'upsert', deletedAt: null });
      expect((await f.history.list('items', key())).map((v) => v.version)).toEqual([4, 3, 2, 1]);
    } finally {
      f.close();
    }
  });

  it('captures bulk and import updates', async () => {
    const f = await fixture(kind);
    try {
      await f.resource.execute('bulkPatch', {
        body: { filter: { title: 'original' }, data: { title: 'bulk' } },
        vars,
      });
      await f.resource.execute('import', {
        query: { mode: 'upsert' },
        body: [{ id: 'one', title: 'import' }],
        vars,
      });
      expect((await f.history.list('items', key())).map((entry) => entry.version)).toEqual([2, 1]);
      expect(await f.audit.query({ tenantNamespace: namespace })).toHaveLength(3);
    } finally {
      f.close();
    }
  });

  it('keeps global model history global inside a tenant-owned transaction', async () => {
    const f = await fixture(kind);
    try {
      const globalModel = defineModel({
        name: 'shared',
        tableName: 'items',
        schema: model.schema,
        id: 'client',
        timestamps: false,
        softDelete: true,
        versioning: true,
        audit: true,
      });
      const shared = defineResource('shared', { ...f.config, model: globalModel });
      await shared.execute('create', {
        body: { id: 'shared', title: 'global', tenantId: 'shared' },
        vars,
      });
      await crudTransaction(f.adapter, vars, async (transaction) => {
        await shared.execute('update', {
          id: 'shared',
          body: { title: 'updated global' },
          vars,
          transaction,
        });
        await f.resource.execute('update', {
          id: 'one',
          body: { title: 'updated tenant' },
          vars,
          transaction,
        });
      });
      expect(await f.audit.query()).toHaveLength(2);
      expect(await f.audit.query({ tenantNamespace: namespace })).toHaveLength(2);
      expect(
        await f.history.list('items', {
          tenantNamespace: 'global',
          primaryKey: JSON.stringify([['id', 'string', 'shared']]),
        }),
      ).toHaveLength(1);
      expect(await f.history.list('items', key())).toHaveLength(1);
      await expect(
        crudTransaction(f.adapter, vars, (transaction) =>
          shared.execute('read', {
            id: 'shared',
            transaction,
            vars: { tenantId: 'tenant-b' },
          }),
        ),
      ).rejects.toThrow('tenant mismatch');
    } finally {
      f.close();
    }
  });

  it('rejects foreign, expired, cross-tenant and duplicate-version store operations', async () => {
    const f = await fixture(kind);
    try {
      let retained!: ReturnType<NonNullable<typeof f.audit.transaction>['bind']>;
      await crudTransaction(f.adapter, vars, async (transaction) => {
        await withCrudTransactionStore(transaction, f.audit.transaction!, vars, async (store) => {
          retained = store;
        });
      });
      await expect(retained.query()).rejects.toThrow(/expired/i);
      await expect(
        crudTransaction(f.adapter, vars, async (transaction) => {
          await withCrudTransactionStore(transaction, f.audit.transaction!, vars, async (store) => {
            await store
              .query({ tenantNamespace: historyTenantNamespace('tenant-b') })
              .catch(() => undefined);
          });
        }),
      ).rejects.toThrow('rolled back');
      await expect(
        crudTransaction(f.adapter, vars, async (transaction) => {
          await withCrudTransactionStore(
            transaction,
            { ...f.audit.transaction!, owner: {} },
            vars,
            (store) => store.query(),
          );
        }),
      ).rejects.toThrow('Foreign');
      await f.resource.execute('update', { id: 'one', body: { title: 'second' }, vars });
      const entry = (await f.history.list('items', key()))[0]!;
      await expect(
        f.history.save('items', key(), { ...entry, id: crypto.randomUUID() }),
      ).rejects.toThrow();
      expect(await f.history.list('items', key())).toHaveLength(1);
    } finally {
      f.close();
    }
  });
});

it('fails before writes for unbound stores, missing physical uniqueness, and unsupported drivers', async () => {
  expect(() =>
    defineResource('items', {
      model,
      adapter: memoryAdapter({ tableName: 'items' }),
      versioningStore: new MemoryVersioningStore(),
      auditStore: new MemoryAuditStore(),
    }),
  ).toThrow('transaction-aware');
  const f = await fixture('sqlite');
  try {
    await f.client!.execute('DROP INDEX version_identity');
    await expect(
      f.resource.execute('create', { body: { id: 'two', title: 'new' }, vars }),
    ).rejects.toThrow('physical UNIQUE');
    expect(await f.db!.select().from(items)).toHaveLength(1);
    const unsupported = drizzleAdapter({ db: f.db!, table: items, driver: 'd1' });
    expect(() => defineResource('items', { ...f.config, adapter: unsupported })).toThrow(
      'transaction-aware',
    );
  } finally {
    f.close();
  }
});

it('rolls back captured history when the native write fails', async () => {
  const f = await fixture('sqlite');
  try {
    await expect(
      f.resource.execute('update', { id: 'one', body: { title: 'invalid' }, vars }),
    ).rejects.toThrow();
    await expect(
      f.resource.execute('import', {
        query: { mode: 'upsert' },
        body: [
          { id: 'one', title: 'changed' },
          { id: 'one', title: 'invalid' },
        ],
        vars,
      }),
    ).rejects.toThrow();
    expect((await f.row())?.title).toBe('original');
    expect(await f.history.list('items', key())).toEqual([]);
    expect(await f.audit.query({ tenantNamespace: namespace })).toHaveLength(1);
  } finally {
    f.close();
  }
});

it('isolates equal audit IDs across tenants, excludes legacy NULL rows, and validates query bounds', async () => {
  const f = await fixture('sqlite');
  try {
    await f.audit.log({
      id: 'other',
      recordId: 'one',
      tableName: 'items',
      action: 'create',
      timestamp: new Date(100),
      tenantNamespace: historyTenantNamespace('global'),
    });
    await f.client!.execute(
      "INSERT INTO audits(id, timestamp, action, tableName, recordId) VALUES ('legacy', 0, 'create', 'items', 'one')",
    );
    expect(await f.audit.query()).toEqual([]);
    expect(
      (await f.audit.query({ tenantNamespace: historyTenantNamespace('global') })).map((e) => e.id),
    ).toEqual(['other']);
    expect(await f.audit.query({ tenantNamespace: namespace, endDate: new Date(200) })).toEqual([]);
    for (const options of [
      { limit: -1 },
      { offset: 0.5 },
      { startDate: new Date(NaN) },
      { startDate: new Date(200), endDate: new Date(100) },
      { tenantNamespace: 'tenant:bad' },
    ])
      await expect(f.audit.query(options)).rejects.toThrow();
  } finally {
    f.close();
  }
});

it('keeps postCommit auditing explicitly best effort', async () => {
  const store = new MemoryStore();
  const adapter = transactionalMemoryAdapter({ store, tableName: 'plain' });
  const simple = defineModel({
    name: 'plain',
    schema: z.object({ id: z.string() }),
    id: 'client',
    timestamps: false,
    audit: true,
  });
  const audit = new MemoryAuditStore();
  audit.log = async () => {
    throw new Error('external unavailable');
  };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const resource = defineResource('plain', {
      model: simple,
      adapter,
      auditStore: audit,
      auditPersistence: { mode: 'postCommit' },
    });
    expect((await resource.execute('create', { body: { id: 'one' } })).status).toBe(201);
    expect(
      await adapter.requestScope((scope) =>
        adapter.readOne({ field: 'id', value: 'one' }, {}, scope),
      ),
    ).toEqual({ id: 'one' });
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

it('does not partially commit memory tables when participant cloning fails', async () => {
  const owner = new MemoryStore();
  const participant = { create: (): { value: unknown } => ({ value: 1 }) };
  owner.table('items').set('one', { id: 'one', value: 'original' });
  await expect(
    owner.transaction(async (scope) => {
      const tx = owner.inScope(scope);
      tx.table('items').set('one', { id: 'one', value: 'changed' });
      tx.participant(participant).value = () => undefined;
    }),
  ).rejects.toThrow();
  expect(owner.table('items').get('one')).toEqual({ id: 'one', value: 'original' });
  expect(owner.participant(participant)).toEqual({ value: 1 });
});

it('drains an unawaited native store method before rollback and never lets it write after scope closure', async () => {
  const f = await fixture('sqlite');
  let completed = false;
  const binding = drizzleTransactionStore(f.db!, (run) => ({
    insert: () =>
      run(async (native) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await native
          .insert(items)
          .values({ id: 'late', title: 'pending', tenantId: vars.tenantId, version: 1 });
        completed = true;
      }),
  }));
  try {
    await expect(
      crudTransaction(f.adapter, vars, async (transaction) => {
        await f.resource.execute('update', {
          transaction,
          id: 'one',
          body: { title: 'changed' },
          vars,
        });
        await withCrudTransactionStore(transaction, binding, vars, async (store) => {
          void store.insert().catch(() => undefined);
        });
      }),
    ).rejects.toThrow('rolled back');
    expect(completed).toBe(true);
    expect(await f.db!.select().from(items)).toEqual([
      expect.objectContaining({ id: 'one', title: 'original', version: 1 }),
    ]);
    expect(await f.history.list('items', key())).toEqual([]);
  } finally {
    f.close();
  }
});
