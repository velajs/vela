import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  createCrudDatabaseRegistry,
  crudTransaction,
  defineCrudDatabase,
  defineModel,
  defineResource,
} from '@velajs/crud';
import { historyTenantNamespace } from '@velajs/crud/versioning';
import { drizzleAdapter, DrizzleAuditStore, DrizzleVersioningStore } from '@velajs/crud-drizzle';
import { z } from 'zod';

export async function verifyTransactionalHistory() {
  const directory = await mkdtemp(join(tmpdir(), 'vela-packed-history-'));
  const client = createClient({ url: `file:${join(directory, 'history.db')}` });
  try {
    await client.executeMultiple(`
      CREATE TABLE history_items (tenantId TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, version INTEGER, PRIMARY KEY(tenantId,id));
      CREATE TABLE history_versions (id TEXT PRIMARY KEY, tableName TEXT NOT NULL, recordId TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL, changedBy TEXT, changeReason TEXT);
      CREATE UNIQUE INDEX history_identity ON history_versions(tableName,recordId,version);
      CREATE TABLE history_audit (id TEXT PRIMARY KEY, tenantNamespace TEXT, timestamp INTEGER NOT NULL, action TEXT NOT NULL, tableName TEXT NOT NULL, recordId TEXT NOT NULL, userId TEXT, record TEXT, previousRecord TEXT, changes TEXT, metadata TEXT);
    `);
    const items = sqliteTable(
      'history_items',
      {
        tenantId: text().notNull(),
        id: text().notNull(),
        label: text().notNull(),
        version: integer(),
      },
      (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
    );
    const versions = sqliteTable(
      'history_versions',
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
      (table) => [
        uniqueIndex('history_identity').on(table.tableName, table.recordId, table.version),
      ],
    );
    const auditTable = sqliteTable('history_audit', {
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
    const db = drizzle(client);
    const model = defineModel({
      name: 'item',
      tableName: 'history_items',
      primaryKeys: ['tenantId', 'id'],
      id: 'client',
      timestamps: false,
      multiTenant: true,
      versioning: true,
      audit: true,
      schema: z.object({
        tenantId: z.string(),
        id: z.string(),
        label: z.string(),
        version: z.number().optional(),
      }),
    });
    const native = drizzleAdapter({ db, table: items, primaryKeys: ['tenantId', 'id'] });
    const configuration = defineCrudDatabase('main', {
      handle: db,
      resources: { item: { model, adapter: native } },
      auditStore: Object.freeze(new DrizzleAuditStore(db, auditTable)),
      versioningStore: Object.freeze(new DrizzleVersioningStore(db, versions)),
    });
    const application = createCrudDatabaseRegistry([configuration]).forApplication();
    const registered = application.resolve('main');
    const adapter = registered.resources.item.adapter;
    const resource = defineResource('items', {
      model,
      adapter,
      auditStore: registered.auditStore,
      versioningStore: registered.versioningStore,
      auditPersistence: { mode: 'transaction' },
    });
    for (const tenantId of ['a', 'b'])
      await resource.execute('create', {
        vars: { tenantId },
        body: { id: 'same', tenantId, label: tenantId },
      });
    const request = {
      vars: { tenantId: 'a' },
      id: { tenantId: 'a', id: 'same' },
      body: { label: 'updated' },
    };
    await assert.rejects(
      crudTransaction(adapter, { tenantId: 'a' }, async (transaction) => {
        await resource.execute('update', { ...request, transaction });
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal((await db.select().from(versions)).length, 0);
    assert.deepEqual((await db.select().from(items)).map((row) => row.label).sort(), ['a', 'b']);
    await crudTransaction(adapter, { tenantId: 'a' }, async (transaction) => {
      await resource.execute('update', { ...request, transaction });
      const version = await resource.execute('versionRead', {
        transaction,
        vars: request.vars,
        id: request.id,
        params: { version: '1' },
      });
      assert.equal(version.body.result.data.label, 'a');
    });
    assert.equal((await db.select().from(versions)).length, 1);
    assert.equal((await registered.auditStore.query()).length, 0);
    assert.equal(
      (await registered.auditStore.query({ tenantNamespace: historyTenantNamespace('a') })).length,
      2,
    );
    assert.equal(
      (await registered.auditStore.query({ tenantNamespace: historyTenantNamespace('b') })).length,
      1,
    );
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
}
