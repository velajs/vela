import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { bigint, integer, pgSchema, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Module, VelaFactory } from '@velajs/vela';
import { createExecutionScope, runInEntrypointScope } from '@velajs/vela/module-kit';
import {
  CrudModule,
  CRUD_DATABASES,
  acquireCrudDatabases,
  createCrudDatabaseRegistry,
  crudResourceToken,
  crudTransaction,
  defineCrudDatabase,
  defineCrudFeature,
  defineModel,
  withCrudTransactionStore,
} from '@velajs/crud';
import { drizzleAdapter, DrizzleAuditStore, DrizzleVersioningStore } from '@velajs/crud-drizzle';
import { historyTenantNamespace } from '@velajs/crud/versioning';

const url = process.env.VELA_POSTGRES_URL;
describe.skipIf(!url)('request clients on real PostgreSQL', () => {
  const schemaName = `request_${crypto.randomUUID().replaceAll('-', '')}`;
  const schema = pgSchema(schemaName);
  const items = schema.table('items', {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    title: text().notNull(),
    version: integer(),
  });
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
    (t) => [uniqueIndex('history_identity').on(t.tableName, t.recordId, t.version)],
  );
  const model = defineModel({
    name: 'item',
    tableName: 'items',
    id: 'client',
    timestamps: false,
    multiTenant: true,
    audit: true,
    versioning: true,
    schema: z.object({
      id: z.string(),
      tenantId: z.string(),
      title: z.string(),
      version: z.number().optional(),
    }),
  });
  const admin = new Pool({ connectionString: url, max: 1 });
  const clients: Client[] = [],
    released: Client[] = [];
  @Module({
    imports: [
      CrudModule.forRequestAsync({
        useFactory: (lifetime) =>
          acquireCrudDatabases({
            signal: lifetime.signal,
            acquire: () => {
              const client = new Client({ connectionString: url });
              clients.push(client);
              return client;
            },
            create: async (client) => {
              await client.connect();
              const db = drizzle(client);
              return createCrudDatabaseRegistry([
                defineCrudDatabase('main', {
                  handle: db,
                  resources: {
                    item: { model, adapter: drizzleAdapter({ db, dialect: 'pg', table: items }) },
                  },
                  auditStore: new DrizzleAuditStore(db, audits),
                  versioningStore: new DrizzleVersioningStore(db, versions),
                }),
              ]);
            },
            release: async (client) => {
              released.push(client);
              await client.end();
            },
          }),
      }),
      CrudModule.forFeature([
        defineCrudFeature({
          path: '/items',
          model,
          database: 'main',
          tenantResolverMounted: true,
          auditPersistence: { mode: 'transaction' },
        }),
      ]),
    ],
  })
  class App {}
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`
      CREATE TABLE "${schemaName}".items (id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, title TEXT NOT NULL CHECK(title <> 'invalid'), version INTEGER);
      CREATE TABLE "${schemaName}".versions (id TEXT PRIMARY KEY, "tableName" TEXT NOT NULL, "recordId" TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, "createdAt" BIGINT NOT NULL, "changedBy" TEXT, "changeReason" TEXT, UNIQUE("tableName", "recordId", version));
      CREATE TABLE "${schemaName}".audits (id TEXT PRIMARY KEY, "tenantNamespace" TEXT, timestamp BIGINT NOT NULL, action TEXT NOT NULL, "tableName" TEXT NOT NULL, "recordId" TEXT NOT NULL, "userId" TEXT, record TEXT, "previousRecord" TEXT, changes TEXT, metadata TEXT);
    `);
  });
  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it('owns separate overlapping clients and rolls back rows, audit and versions together before release', async () => {
    const app = await VelaFactory.create(App);
    const first = createExecutionScope(app.getContainer()),
      second = createExecutionScope(app.getContainer());
    try {
      const [a, b] = await Promise.all([
        first.container.resolveAsync(crudResourceToken('item', 'main')),
        second.container.resolveAsync(crudResourceToken('item', 'main')),
      ]);
      const [pidA, pidB] = await Promise.all(
        clients.map((client) => client.query('SELECT pg_backend_pid() AS pid')),
      );
      expect(pidA!.rows[0].pid).not.toBe(pidB!.rows[0].pid);
      const vars = { tenantId: 'a' };
      await a.execute('create', { vars, body: { id: 'one', title: 'original' } });
      const database = (await first.container.resolveAsync(CRUD_DATABASES))!.get('main');
      await expect(
        crudTransaction({ runtime: a.config.adapter }, vars, async (transaction) => {
          await a.execute('update', { transaction, vars, id: 'one', body: { title: 'rollback' } });
          await withCrudTransactionStore(
            transaction,
            database.auditStore!.transaction!,
            vars,
            async (store) => {
              expect(await store.query({ recordId: 'one' })).toHaveLength(2);
            },
          );
          throw new Error('rollback requested');
        }),
      ).rejects.toThrow('rollback requested');
      expect((await admin.query(`SELECT title FROM "${schemaName}".items`)).rows).toEqual([
        { title: 'original' },
      ]);
      expect((await admin.query(`SELECT * FROM "${schemaName}".versions`)).rows).toHaveLength(0);
      expect((await admin.query(`SELECT * FROM "${schemaName}".audits`)).rows).toHaveLength(1);
      await expect(
        crudTransaction({ runtime: a.config.adapter }, vars, (transaction) =>
          b.execute('list', { transaction, vars }),
        ),
      ).rejects.toThrow('Foreign');
      await expect(
        a.execute('update', { vars, id: 'one', body: { title: 'invalid' } }),
      ).rejects.toThrow();
      await a.execute('update', { vars, id: 'one', body: { title: 'committed' } });
      expect(
        await database.auditStore!.query({ tenantNamespace: historyTenantNamespace('a') }),
      ).toHaveLength(2);
      expect((await admin.query(`SELECT * FROM "${schemaName}".versions`)).rows).toHaveLength(1);
      expect(released).toEqual([]);
      await first.finish();
      await first.finish();
      expect(released).toEqual([clients[0]]);
      await expect(clients[0]!.query('SELECT 1')).rejects.toThrow(/closed|not queryable/);
      expect(() => database.auditStore!.query()).toThrow('closed');
      await expect(b.execute('list', { vars: { tenantId: 'b' } })).resolves.toMatchObject({
        body: { result: [] },
      });
    } finally {
      await Promise.all([first.finish(), second.finish()]);
      await app.close();
    }
    expect(released).toHaveLength(2);
  });

  it('releases after a managed handler throw and after post-acquire connect failure', async () => {
    const app = await VelaFactory.create(App);
    const previous = released.length;
    try {
      await expect(
        runInEntrypointScope(app.getContainer(), async (child) => {
          await child.resolveAsync(crudResourceToken('item', 'main'));
          throw new Error('handler failed');
        }),
      ).rejects.toThrow('handler failed');
      expect(released).toHaveLength(previous + 1);
      const client = new Client({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 200 });
      let ended = 0;
      await expect(
        acquireCrudDatabases({
          acquire: () => client,
          create: async (c) => {
            await c.connect();
            throw new Error('unreachable');
          },
          release: async (c) => {
            ended++;
            await c.end();
          },
        }),
      ).rejects.toThrow();
      expect(ended).toBe(1);
    } finally {
      await app.close();
    }
  });
});
