import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Module, VelaFactory } from '@velajs/vela';
import { runInEntrypointScope } from '@velajs/vela/module-kit';
import {
  acquireCrudDatabases,
  createCrudDatabaseRegistry,
  CrudModule,
  crudResourceToken,
  defineCrudDatabase,
  defineCrudFeature,
  defineModel,
} from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { z } from 'zod';

export async function verifyRequestDatabases() {
  const table = sqliteTable('items', { id: text().primaryKey(), title: text().notNull() });
  const model = defineModel({
    name: 'item',
    tableName: 'items',
    id: 'client',
    timestamps: false,
    schema: z.object({ id: z.string(), title: z.string() }),
  });
  let acquired = 0,
    released = 0;
  class App {}
  Module({
    imports: [
      CrudModule.forRequestAsync({
        useFactory: (lifetime) =>
          acquireCrudDatabases({
            signal: lifetime.signal,
            acquire: () => {
              acquired++;
              return createClient({ url: ':memory:' });
            },
            create: async (client) => {
              await client.execute('CREATE TABLE items(id TEXT PRIMARY KEY, title TEXT NOT NULL)');
              const db = drizzle(client);
              return createCrudDatabaseRegistry([
                defineCrudDatabase('main', {
                  handle: db,
                  resources: { item: { model, adapter: drizzleAdapter({ db, table }) } },
                }),
              ]);
            },
            release: (client) => {
              released++;
              client.close();
            },
          }),
      }),
      CrudModule.forFeature([defineCrudFeature({ path: '/items', model, database: 'main' })]),
    ],
  })(App);
  const app = await VelaFactory.create(App);
  try {
    assert.equal(acquired, 0);
    await assert.rejects(
      app.getContainer().resolveAsync(crudResourceToken('item', 'main')),
      /request.scoped/,
    );
    let escaped;
    await runInEntrypointScope(app.getContainer(), async (child) => {
      const item = await child.resolveAsync(crudResourceToken('item', 'main'));
      assert.equal(item, await child.resolveAsync(crudResourceToken('item', 'main')));
      await item.execute('create', { body: { id: 'one', title: 'synthetic' } });
      escaped = item;
    });
    assert.equal(acquired, 1);
    assert.equal(released, 1);
    await assert.rejects(escaped.execute('list', {}), /closed/);
  } finally {
    await app.close();
  }
}
