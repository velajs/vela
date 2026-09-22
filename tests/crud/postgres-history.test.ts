import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { bigint, integer, pgSchema, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { defineModel, defineResource } from '@velajs/crud';
import {
  crudTransaction,
  withCrudTransactionStore,
} from '../../packages/crud/src/kernel/transaction';
import { drizzleAdapter, DrizzleVersioningStore, DrizzleAuditStore } from '@velajs/crud-drizzle';
import { historyTenantNamespace, type VersioningStore } from '@velajs/crud/versioning';

const url = process.env.VELA_POSTGRES_URL;

describe.skipIf(!url)('live PostgreSQL transactional history', () => {
  const schemaName = `history_${crypto.randomUUID().replaceAll('-', '')}`;
  const schema = pgSchema(schemaName);
  const items = schema.table('items', {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    title: text().notNull(),
    version: integer(),
  });
  const versions = schema.table(
    'versions',
    {
      id: text().primaryKey(),
      tableName: text().notNull(),
      recordId: text().notNull(),
      version: integer().notNull(),
      data: text().notNull(),
      createdAt: bigint({ mode: 'number' }).notNull(),
      changedBy: text(),
      changeReason: text(),
    },
    (t) => [uniqueIndex('version_identity').on(t.tableName, t.recordId, t.version)],
  );
  const audits = schema.table('audits', {
    id: text().primaryKey(),
    tenantNamespace: text(),
    timestamp: bigint({ mode: 'number' }).notNull(),
    action: text().notNull(),
    tableName: text().notNull(),
    recordId: text().notNull(),
    userId: text(),
    record: text(),
    previousRecord: text(),
    changes: text(),
    metadata: text(),
  });
  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool);
  const adapter = drizzleAdapter({ db, dialect: 'pg', table: items });
  const history = new DrizzleVersioningStore(db, versions);
  const audit = new DrizzleAuditStore(db, audits);
  const model = defineModel({
    name: 'entry',
    tableName: 'items',
    timestamps: false,
    id: 'client',
    multiTenant: true,
    versioning: true,
    audit: true,
    schema: z.object({
      id: z.string(),
      tenantId: z.string(),
      title: z.string(),
      version: z.number().optional(),
    }),
  });
  const config = {
    model,
    adapter,
    versioningStore: history,
    auditStore: audit,
    auditPersistence: { mode: 'transaction' as const },
  };
  const resource = defineResource('entry', config);
  const vars = { tenantId: 'tenant-a' };
  const key = (id: string) => ({
    tenantNamespace: historyTenantNamespace(vars.tenantId),
    primaryKey: JSON.stringify([['id', 'string', id]]),
  });
  const row = (id: string) =>
    adapter.requestScope((scope) => adapter.readOne({ field: 'id', value: id }, {}, scope));

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    await pool.query(`
      CREATE TABLE "${schemaName}".items (id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, title TEXT NOT NULL CHECK(title <> 'invalid'), version INTEGER);
      CREATE TABLE "${schemaName}".versions (id TEXT PRIMARY KEY, "tableName" TEXT NOT NULL, "recordId" TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, "createdAt" BIGINT NOT NULL, "changedBy" TEXT, "changeReason" TEXT);
      CREATE UNIQUE INDEX version_identity ON "${schemaName}".versions("tableName", "recordId", version);
      CREATE TABLE "${schemaName}".audits (id TEXT PRIMARY KEY, "tenantNamespace" TEXT, timestamp BIGINT NOT NULL, action TEXT NOT NULL, "tableName" TEXT NOT NULL, "recordId" TEXT NOT NULL, "userId" TEXT, record TEXT, "previousRecord" TEXT, changes TEXT, metadata TEXT);
    `);
  });
  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it('commits composed version/audit writes and rolls back failed hooks and native constraints', async () => {
    await resource.execute('create', { body: { id: 'rollback', title: 'original' }, vars });
    const failing = defineResource('entry', {
      ...config,
      hooks: {
        afterUpdate() {
          throw new Error('hook failed');
        },
      },
    });
    await expect(
      failing.execute('update', { id: 'rollback', body: { title: 'changed' }, vars }),
    ).rejects.toThrow('hook failed');
    await expect(
      resource.execute('update', { id: 'rollback', body: { title: 'invalid' }, vars }),
    ).rejects.toThrow();
    expect(await history.list('items', key('rollback'))).toEqual([]);
    expect(await row('rollback')).toMatchObject({ title: 'original', version: 1 });
    await expect(
      crudTransaction(adapter, vars, async (transaction) => {
        await resource.execute('update', {
          id: 'rollback',
          body: { title: 'changed' },
          vars,
          transaction,
        });
        await withCrudTransactionStore(transaction, audit.transaction!, vars, async (store) => {
          expect(await store.query({ recordId: 'rollback' })).toHaveLength(2);
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await history.list('items', key('rollback'))).toEqual([]);
    await crudTransaction(adapter, vars, async (transaction) => {
      await resource.execute('update', {
        id: 'rollback',
        body: { title: 'committed' },
        vars,
        transaction,
      });
    });
    expect(await history.list('items', key('rollback'))).toHaveLength(1);
    expect(
      await audit.query({ tenantNamespace: key('rollback').tenantNamespace, recordId: 'rollback' }),
    ).toHaveLength(2);
  });

  it('rejects concurrent duplicate versions without lost writes or orphan snapshots', async () => {
    await resource.execute('create', { body: { id: 'race', title: 'original' }, vars });
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racingStore: VersioningStore = {
      save: history.save.bind(history),
      list: history.list.bind(history),
      get: history.get.bind(history),
      latest: history.latest.bind(history),
      transaction: {
        owner: history.transaction!.owner,
        bind(scope, context, onError) {
          const bound = history.transaction!.bind(scope, context, onError);
          return {
            ...bound,
            async save(...args) {
              if (++arrived === 2) release();
              await barrier;
              return bound.save(...args);
            },
          };
        },
      },
    };
    const racing = defineResource('entry', { ...config, versioningStore: racingStore });
    const outcomes = await Promise.allSettled(
      ['first', 'second'].map((title) =>
        racing.execute('update', { id: 'race', body: { title }, vars }),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(await row('race')).toMatchObject({ version: 2 });
    expect((await history.list('items', key('race'))).map((entry) => entry.version)).toEqual([1]);
    expect(
      await audit.query({ tenantNamespace: key('race').tenantNamespace, recordId: 'race' }),
    ).toHaveLength(2);
    await resource.execute('update', { id: 'race', body: { title: 'retry' }, vars });
    expect((await history.list('items', key('race'))).map((entry) => entry.version)).toEqual([
      2, 1,
    ]);
  });

  it('rejects a missing physical constraint before a create writes anything', async () => {
    await pool.query(`DROP INDEX "${schemaName}".version_identity`);
    await expect(
      resource.execute('create', { body: { id: 'missing-index', title: 'blocked' }, vars }),
    ).rejects.toThrow('physical UNIQUE');
    expect(await row('missing-index')).toBeNull();
  });
});
