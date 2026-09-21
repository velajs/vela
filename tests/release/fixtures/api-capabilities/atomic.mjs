import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { defineModel, defineResource, executeAtomicBatch, requireAtomicBatch } from '@velajs/crud';
import { DrizzleAuditStore, drizzleAdapter } from '@velajs/crud-drizzle';
import { z } from 'zod';

export async function verifyAtomicWrites() {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.executeMultiple(`
      CREATE TABLE records (id TEXT PRIMARY KEY, label TEXT NOT NULL);
      CREATE TABLE links (id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id));
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, action TEXT NOT NULL,
        table_name TEXT NOT NULL, record_id TEXT NOT NULL, user_id TEXT,
        record TEXT, previous_record TEXT, changes TEXT, metadata TEXT
      );
    `);
    const records = sqliteTable('records', { id: text().primaryKey(), label: text().notNull() });
    const links = sqliteTable('links', {
      id: text().primaryKey(),
      recordId: text('record_id')
        .notNull()
        .references(() => records.id),
    });
    const auditTable = sqliteTable('audit_log', {
      id: text().primaryKey(),
      timestamp: integer().notNull(),
      action: text().notNull(),
      tableName: text('table_name').notNull(),
      recordId: text('record_id').notNull(),
      userId: text('user_id'),
      record: text(),
      previousRecord: text('previous_record'),
      changes: text(),
      metadata: text(),
    });
    const db = drizzle(client);
    const row = z.object({ id: z.string(), label: z.string() });
    const adapter = drizzleAdapter({ db, table: records, parseRow: (value) => row.parse(value) });
    const related = drizzleAdapter({
      db,
      table: links,
      parseRow: (value) => z.object({ id: z.string(), recordId: z.string() }).parse(value),
    });
    const batch = requireAtomicBatch(adapter);
    const relatedBatch = requireAtomicBatch(related);
    const audit = new DrizzleAuditStore(db, auditTable);
    const entry = (id, recordId) =>
      audit.atomic.prepare({
        id,
        recordId,
        timestamp: new Date(),
        action: 'create',
        tableName: 'records',
        userId: 'fixture',
      });
    const result = await executeAtomicBatch(adapter, [
      batch.create({ id: 'one', label: 'First' }, { audit: entry('log-one', 'one') }),
      relatedBatch.create({ id: 'link-one', recordId: 'one' }),
    ]);
    assert.deepEqual(result, [
      { id: 'one', label: 'First' },
      { id: 'link-one', recordId: 'one' },
    ]);
    assert.equal((await audit.query()).length, 1);

    await assert.rejects(
      executeAtomicBatch(adapter, [
        batch.create({ id: 'rollback', label: 'Never committed' }),
        relatedBatch.create({ id: 'link-one', recordId: 'rollback' }),
      ]),
    );
    assert.deepEqual(await db.select().from(records), [{ id: 'one', label: 'First' }]);
    await assert.rejects(
      executeAtomicBatch(adapter, [
        batch.create(
          { id: 'failed-audit', label: 'Never committed' },
          { audit: entry('log-one', 'failed-audit') },
        ),
      ]),
    );
    assert.deepEqual(await db.select().from(records), [{ id: 'one', label: 'First' }]);

    const [miss] = await executeAtomicBatch(adapter, [
      batch.update(
        { field: 'id', value: 'missing' },
        { label: 'Missing' },
        { audit: entry('log-missing', 'missing') },
      ),
    ]);
    assert.equal(miss, null);
    assert.equal((await audit.query()).length, 1, 'a scoped no-op must not produce an audit entry');

    const resource = defineResource('records', {
      model: defineModel({
        name: 'record',
        tableName: 'records',
        schema: row,
        timestamps: false,
        id: 'client',
        audit: true,
      }),
      adapter,
      auditStore: audit,
      auditPersistence: { mode: 'atomic', snapshots: 'none' },
    });
    const created = await resource.execute('create', {
      body: { id: 'two', label: 'Second' },
      vars: { userId: 'fixture' },
    });
    assert.equal(created.status, 201);
    const entries = await audit.query({ recordId: 'two' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].userId, 'fixture');
    assert.equal(entries[0].record, undefined);
    assert.equal(entries[0].previousRecord, undefined);
  } finally {
    client.close();
  }
}
