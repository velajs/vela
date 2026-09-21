import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Module, VelaFactory } from '@velajs/vela';
import {
  CrudModule,
  CRUD_DATABASES,
  crudResourceToken,
  defineCrudFeature,
  defineModel,
  defineResource,
  defineCrudDatabase,
  createCrudDatabaseRegistry,
  databaseResource,
  crudTransaction,
  type CrudTransactionScope,
} from '@velajs/crud';
import { MemoryStore, memoryAdapter, transactionalMemoryAdapter } from '@velajs/crud-memory';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { MemoryAuditStore } from '@velajs/crud/audit';
import { MemoryVersioningStore } from '@velajs/crud/versioning';

const schema = z.object({ id: z.string(), title: z.string() });
const item = defineModel({
  name: 'item',
  tableName: 'items',
  schema,
  id: 'client',
  timestamps: false,
});
const item2 = defineModel({
  name: 'entry',
  tableName: 'entries',
  schema,
  id: 'client',
  timestamps: false,
});
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function memoryDatabase(name: string, model = item, store = new MemoryStore()) {
  return defineCrudDatabase(name, {
    handle: store,
    resources: {
      item: { model, adapter: transactionalMemoryAdapter({ tableName: model.tableName, store }) },
    },
  });
}

async function appFor(
  databases: ReturnType<typeof createCrudDatabaseRegistry>,
  defaultMapping = false,
) {
  @Module({
    imports: [
      CrudModule.forRootAsync({ useFactory: async () => ({ databases }) }),
      CrudModule.forFeature(
        [
          defineCrudFeature({ path: '/main/items', model: item }),
          defineCrudFeature({ path: '/other/items', model: item, database: 'other' }),
        ],
        defaultMapping ? {} : { database: 'main' },
      ),
    ],
  })
  class App {}
  return VelaFactory.create(App);
}

describe('named databases', () => {
  it('routes identical resource names independently, preserves async roots and isolates two apps', async () => {
    const create = () =>
      createCrudDatabaseRegistry([memoryDatabase('main'), memoryDatabase('other')]);
    const a = await appFor(create());
    const b = await appFor(create());
    try {
      expect(crudResourceToken('item', 'main')).not.toBe(crudResourceToken('item', 'other'));
      expect(crudResourceToken('item', 'main')).toBe(crudResourceToken('item', 'main'));
      expect(
        (await a.getHonoApp().request('/main/items', json({ id: '1', title: 'main-A' }))).status,
      ).toBe(201);
      expect(
        (await a.getHonoApp().request('/other/items', json({ id: '1', title: 'other-A' }))).status,
      ).toBe(201);
      expect(await (await a.getHonoApp().request('/main/items/1')).json()).toMatchObject({
        result: { title: 'main-A' },
      });
      expect(await (await a.getHonoApp().request('/other/items/1')).json()).toMatchObject({
        result: { title: 'other-A' },
      });
      expect((await b.getHonoApp().request('/main/items/1')).status).toBe(404);
      const ar = a.getContainer().resolve(crudResourceToken('item', 'main'));
      const br = b.getContainer().resolve(crudResourceToken('item', 'main'));
      await crudTransaction({ runtime: ar.config.adapter }, {}, async (transaction) => {
        await expect(br.execute('list', { transaction })).rejects.toThrow('Foreign');
      }).catch((error: Error) => expect(error.message).toContain('rolled back'));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('keeps an explicitly configured named default and resource override', async () => {
    const registry = createCrudDatabaseRegistry([memoryDatabase('main'), memoryDatabase('other')], {
      defaultDatabase: 'main',
    });
    const app = await appFor(registry, true);
    try {
      expect(
        (await app.getHonoApp().request('/main/items', json({ id: 'd', title: 'default' }))).status,
      ).toBe(201);
      expect((await app.getHonoApp().request('/other/items/d')).status).toBe(404);
      expect(app.getContainer().resolve(crudResourceToken('item')).config.database).toBe('main');
    } finally {
      await app.close();
    }
  });

  it('fails fast for duplicate databases/resources, missing bindings and mismatched models', async () => {
    expect(() =>
      createCrudDatabaseRegistry([memoryDatabase('same'), memoryDatabase('same')]),
    ).toThrow('Duplicate database');
    expect(() =>
      createCrudDatabaseRegistry([memoryDatabase('main')], { defaultDatabase: 'missing' }),
    ).toThrow('Unknown database');
    expect(() =>
      CrudModule.forFeature([
        defineCrudFeature({ path: '/one', model: item, database: 'main' }),
        defineCrudFeature({ path: '/two', model: item, database: 'main' }),
      ]),
    ).toThrow('Duplicate CRUD');
    await expect(appFor(createCrudDatabaseRegistry([memoryDatabase('main')]))).rejects.toThrow(
      'Unknown database',
    );
    await expect(
      appFor(createCrudDatabaseRegistry([memoryDatabase('main', item2), memoryDatabase('other')])),
    ).rejects.toThrow('different model');
  });

  it('rejects cross-database relations and separate owners masquerading as one database', () => {
    const parent = defineModel({
      name: 'parent',
      tableName: 'parents',
      schema,
      relations: {
        children: { type: 'hasMany', target: 'items', foreignKey: 'parentId' },
      },
    });
    expect(() =>
      createCrudDatabaseRegistry([memoryDatabase('main', parent), memoryDatabase('other')]),
    ).toThrow('cross-database relations');
    expect(() =>
      createCrudDatabaseRegistry([
        defineCrudDatabase('bad', {
          handle: {},
          resources: {
            item: memoryDatabase('a').resources.item,
            entry: memoryDatabase('b', item2).resources.item,
          },
        }),
      ]),
    ).toThrow('different transaction owners');
  });

  it('separates database default stores and never borrows legacy defaults', async () => {
    const audited = defineModel({
      name: 'item',
      tableName: 'items',
      schema,
      id: 'client',
      timestamps: false,
      audit: true,
    });
    const one = new MemoryAuditStore();
    const two = new MemoryAuditStore();
    const main = { ...memoryDatabase('main', audited), auditStore: one };
    const other = { ...memoryDatabase('other', audited), auditStore: two };
    @Module({
      imports: [
        CrudModule.forRoot({ databases: createCrudDatabaseRegistry([main, other]) }),
        CrudModule.forFeature([
          defineCrudFeature({ path: '/one', ...databaseResource(main, 'item') }),
          defineCrudFeature({ path: '/two', ...databaseResource(other, 'item') }),
        ]),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      await app.getHonoApp().request('/one', json({ id: 'same', title: 'first' }));
      await app.getHonoApp().request('/two', json({ id: 'same', title: 'second' }));
      expect(await one.query()).toMatchObject([{ record: { title: 'first' } }]);
      expect(await two.query()).toMatchObject([{ record: { title: 'second' } }]);
    } finally {
      await app.close();
    }
    expect(() => createCrudDatabaseRegistry([main, { ...other, auditStore: one }])).toThrow(
      'separate instances',
    );
  });

  it('keeps different app registrations isolated even with the same native handle', async () => {
    const database = memoryDatabase('main');
    const registry = createCrudDatabaseRegistry([database, memoryDatabase('other')]);
    const a = await appFor(registry);
    const b = await appFor(registry);
    try {
      const first = a.getContainer().resolve(crudResourceToken('item', 'main'));
      const second = b.getContainer().resolve(crudResourceToken('item', 'main'));
      await expect(
        crudTransaction({ runtime: first.config.adapter }, {}, async (transaction) => {
          await second.execute('list', { transaction });
        }),
      ).rejects.toThrow('Foreign');
      expect(a.getContainer().resolve(CRUD_DATABASES)).not.toBe(
        b.getContainer().resolve(CRUD_DATABASES),
      );
    } finally {
      await a.close();
      await b.close();
    }
  });
});

function pair(tenant = false) {
  const store = new MemoryStore();
  const model = (name: string) =>
    defineModel({
      name,
      tableName: name,
      id: 'client',
      timestamps: false,
      schema: tenant ? schema.extend({ tenantId: z.string() }) : schema,
      ...(tenant ? { multiTenant: true } : {}),
    });
  const aModel = model('a');
  const bModel = model('b');
  const a = transactionalMemoryAdapter({ tableName: aModel.tableName, store });
  const b = transactionalMemoryAdapter({ tableName: bModel.tableName, store });
  const events: string[] = [];
  const first = defineResource('a', {
    model: aModel,
    adapter: a,
    afterCommit: () => {
      events.push('a');
    },
  });
  const second = defineResource('b', {
    model: bModel,
    adapter: b,
    afterCommit: () => {
      events.push('b');
    },
  });
  return { store, a, b, first, second, events };
}

describe('explicit resource transaction composition', () => {
  it('commits two resources before ordered notification and expires the scope', async () => {
    const { a, first, second, store, events } = pair();
    let retained: CrudTransactionScope | undefined;
    await crudTransaction(a, {}, async (transaction) => {
      retained = transaction;
      await first.execute('create', { transaction, body: { id: '1', title: 'first' } });
      await second.execute('create', { transaction, body: { id: '1', title: 'second' } });
      expect(events).toEqual([]);
      expect(store.table('a').size).toBe(0);
    });
    expect(store.table('a').size).toBe(1);
    expect(store.table('b').size).toBe(1);
    expect(events).toEqual(['a', 'b']);
    await expect(first.execute('list', { transaction: retained })).rejects.toThrow('Expired');
  });

  it('rolls back both resources without notifications, including caught validation errors', async () => {
    const { a, first, second, store, events } = pair();
    await expect(
      crudTransaction(a, {}, async (transaction) => {
        await first.execute('create', { transaction, body: { id: '1', title: 'first' } });
        await second.execute('create', { transaction, body: { id: '1', title: 'second' } });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(store.table('a').size + store.table('b').size).toBe(0);
    expect(events).toEqual([]);
    await expect(
      crudTransaction(a, {}, async (transaction) => {
        await first.execute('create', { transaction, body: { id: '1', title: 'first' } });
        await second
          .execute('create', { transaction, body: { id: '1', title: 42 } })
          .catch(() => {});
      }),
    ).rejects.toThrow('rolled back');
    expect(store.table('a').size).toBe(0);
  });

  it('rejects foreign scopes and preserves tenant and authorization admission', async () => {
    const one = pair(true);
    const other = pair(true);
    await expect(
      crudTransaction(one.a, { tenantId: 'alpha' }, async (transaction) => {
        await other.first.execute('list', { transaction, vars: { tenantId: 'alpha' } });
      }),
    ).rejects.toThrow('Foreign');
    await expect(
      crudTransaction(one.a, { tenantId: 'alpha' }, async (transaction) => {
        await one.first.execute('create', {
          transaction,
          vars: { tenantId: 'beta' },
          body: { id: '1', title: 'bad' },
        });
      }),
    ).rejects.toThrow('tenant mismatch');
    await crudTransaction(one.a, { tenantId: 'alpha' }, async (transaction) => {
      await one.first.execute('create', {
        transaction,
        vars: { tenantId: 'alpha' },
        body: { id: '1', title: 'good' },
      });
      await one.second.execute('create', {
        transaction,
        vars: { tenantId: 'alpha' },
        body: { id: '1', title: 'good' },
      });
    });
    expect(one.store.table('a').get('1')).toMatchObject({ tenantId: 'alpha' });
    const denied = defineResource('denied', {
      model: one.first.model,
      adapter: one.a,
      authorization: () => ({ kind: 'deny' }),
    });
    await expect(
      crudTransaction(one.a, { tenantId: 'alpha' }, async (transaction) => {
        await denied.execute('list', { transaction, vars: { tenantId: 'alpha' } });
      }),
    ).rejects.toThrow();
  });

  it('defers audit deliveries and rejects version stores without transaction support', async () => {
    const store = new MemoryStore();
    const auditStore = new MemoryAuditStore();
    const audited = defineModel({
      name: 'item',
      tableName: 'items',
      schema,
      id: 'client',
      timestamps: false,
      audit: true,
    });
    const adapter = transactionalMemoryAdapter({ tableName: audited.tableName, store });
    const resource = defineResource('item', { model: audited, adapter, auditStore });
    await expect(
      crudTransaction(adapter, {}, async (transaction) => {
        await resource.execute('create', { transaction, body: { id: '1', title: 'one' } });
        expect(await auditStore.query()).toEqual([]);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await auditStore.query()).toEqual([]);
    await crudTransaction(adapter, {}, async (transaction) => {
      await resource.execute('create', { transaction, body: { id: '1', title: 'one' } });
    });
    expect(await auditStore.query()).toHaveLength(1);
    const versioned = defineModel({ name: 'item', tableName: 'items', schema, versioning: true });
    const v = defineResource('versioned', {
      model: versioned,
      adapter,
      versioningStore: new MemoryVersioningStore(),
    });
    await expect(
      crudTransaction(adapter, {}, async (transaction) => {
        await v.execute('list', { transaction });
      }),
    ).rejects.toThrow('Versioning stores cannot join');
  });

  it('rejects adapters without real transactions before entering the callback', async () => {
    let called = false;
    await expect(
      crudTransaction(memoryAdapter({ tableName: item.tableName }), {}, async () => {
        called = true;
      }),
    ).rejects.toThrow('owned callback transactions');
    expect(called).toBe(false);
  });
});

it('maps multiple SQLite handles and a memory adapter simultaneously', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vela-multidb-'));
  const first = createClient({ url: `file:${join(directory, 'a.db')}` });
  const second = createClient({ url: `file:${join(directory, 'b.db')}` });
  const table = sqliteTable('items', { id: text().primaryKey(), title: text().notNull() });
  try {
    await first.execute('CREATE TABLE items (id text PRIMARY KEY, title text NOT NULL)');
    await second.execute('CREATE TABLE items (id text PRIMARY KEY, title text NOT NULL)');
    const a = drizzle(first);
    const b = drizzle(second);
    const sql = (name: string, db: typeof a) =>
      defineCrudDatabase(name, {
        handle: db,
        resources: { item: { model: item, adapter: drizzleAdapter({ db, table }) } },
      });
    const registry = createCrudDatabaseRegistry([
      sql('main', a),
      sql('other', b),
      memoryDatabase('cache'),
    ]);
    const app = await appFor(registry);
    try {
      await app.getHonoApp().request('/main/items', json({ id: 'same', title: 'first' }));
      await app.getHonoApp().request('/other/items', json({ id: 'same', title: 'second' }));
      expect((await first.execute('SELECT title FROM items')).rows[0]?.title).toBe('first');
      expect((await second.execute('SELECT title FROM items')).rows[0]?.title).toBe('second');
      expect(registry.resolve('cache').handle).toBeInstanceOf(MemoryStore);
    } finally {
      await app.close();
    }
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
