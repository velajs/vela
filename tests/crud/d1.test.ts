import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { drizzle } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { defineModel, defineResource } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';

const table = sqliteTable('items', {
  id: text().primaryKey(),
  rank: integer().notNull(),
  tenantId: text().notNull(),
  deletedAt: integer(),
});
const schema = z.object({
  id: z.string(),
  rank: z.number(),
  tenantId: z.string(),
  deletedAt: z.number().nullable().optional(),
});
const model = defineModel({
  name: 'item',
  tableName: 'items',
  schema,
  id: 'client',
  timestamps: false,
  multiTenant: true,
  softDelete: true,
});
const pageSchema = z.object({
  result: schema.array(),
  result_info: z.object({ total_count: z.number(), next_cursor: z.string().optional() }),
});
const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'crud-d1',
        type: 'worker',
        compatibilityDate: '2026-09-20',
        manifest: {
          mainModule: 'worker.js',
          modules: {
            'worker.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("D1 conformance"); } };',
            },
          },
        },
        env: { DB: { type: 'd1', id: 'crud-d1-test' } },
      },
    },
  ],
});
const database = await runtime.getD1Database('DB');
const db = drizzle(database);
const adapter = drizzleAdapter({
  driver: 'd1',
  db,
  table,
  softDeleteField: 'deletedAt',
  parseRow: (value) => schema.parse(value),
});
const resource = defineResource('items', {
  model,
  adapter,
  pagination: { cursor: { enabled: true, field: 'rank' } },
});
const vars = { tenantId: 'a' };
beforeAll(async () => {
  await database.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, rank INTEGER NOT NULL, tenantId TEXT NOT NULL, deletedAt INTEGER)',
  );
});
afterAll(async () => {
  await runtime.dispose();
});

describe('actual workerd D1', () => {
  it('supports scoped CRUD, stable compound cursors and soft-delete visibility without callback transactions', async () => {
    const transaction = vi.spyOn(db, 'transaction');
    for (const [id, rank, tenantId] of [
      ['b', 1, 'a'],
      ['a', 1, 'a'],
      ['c', 2, 'a'],
      ['foreign', 1, 'b'],
    ] as const) {
      expect(
        (await resource.execute('create', { body: { id, rank }, vars: { tenantId } })).status,
      ).toBe(201);
    }
    const first = pageSchema.parse(
      (await resource.execute('list', { query: { limit: '1' }, vars })).body,
    );
    expect(first.result.map((row) => row.id)).toEqual(['a']);
    expect(first.result_info.total_count).toBe(3);
    const second = pageSchema.parse(
      (
        await resource.execute('list', {
          query: { limit: '1', cursor: first.result_info.next_cursor! },
          vars,
        })
      ).body,
    );
    expect(second.result.map((row) => row.id)).toEqual(['b']);
    await expect(resource.execute('read', { id: 'foreign', vars })).rejects.toThrow();
    expect((await resource.execute('update', { id: 'b', body: { rank: 3 }, vars })).status).toBe(
      200,
    );
    await expect(
      resource.execute('update', { id: 'foreign', body: { rank: 99 }, vars }),
    ).rejects.toThrow();
    expect((await resource.execute('delete', { id: 'a', vars })).status).toBe(200);
    await expect(resource.execute('read', { id: 'a', vars })).rejects.toThrow();
    expect(
      pageSchema
        .parse((await resource.execute('list', { vars })).body)
        .result.map((row) => row.id)
        .sort(),
    ).toEqual(['b', 'c']);
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it('rejects rollback-dependent writes before changing data or invoking hooks', async () => {
    const afterCreate = vi.fn();
    const hooked = defineResource('items', { model, adapter, hooks: { afterCreate } });
    await expect(
      hooked.execute('create', { body: { id: 'rollback', rank: 4 }, vars }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_UNSUPPORTED' });
    expect(afterCreate).not.toHaveBeenCalled();
    expect(
      await database.prepare('SELECT id FROM items WHERE id = ?').bind('rollback').first(),
    ).toBeNull();
    const protectedResource = defineResource('items', {
      model: defineModel({
        name: 'item',
        tableName: 'items',
        schema,
        timestamps: false,
        multiTenant: true,
        policies: { write: () => true },
      }),
      adapter,
    });
    await expect(
      protectedResource.execute('update', { id: 'b', body: { rank: 99 }, vars }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_UNSUPPORTED' });
    expect(
      await database.prepare('SELECT rank FROM items WHERE id = ?').bind('b').first('rank'),
    ).toBe(3);
    await expect(
      resource.execute('batchCreate', { body: { items: [{ id: 'batch', rank: 1 }] }, vars }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_UNSUPPORTED' });
  });

  it('fails malformed cursors before database access', async () => {
    const list = vi.spyOn(adapter, 'list');
    await expect(resource.execute('list', { query: { cursor: 'garbage' }, vars })).rejects.toThrow(
      'Invalid cursor',
    );
    expect(list).not.toHaveBeenCalled();
    list.mockRestore();
  });
});

for (const policy of ['read', 'readPushdown'] as const) {
  for (const verb of ['update', 'delete'] as const) {
    it(`rejects D1 ${verb} with ${policy} before changing storage`, async () => {
      const id = `${policy}-${verb}`;
      await database
        .prepare('INSERT INTO items (id, rank, tenantId) VALUES (?, 1, ?)')
        .bind(id, 'a')
        .run();
      const guarded = defineResource('guarded', {
        model: defineModel({
          name: 'item',
          tableName: 'items',
          schema,
          timestamps: false,
          policies:
            policy === 'read'
              ? { read: () => false }
              : {
                  readPushdown: () => [{ field: 'rank', operator: 'eq', value: 99 }],
                },
        }),
        adapter,
      });
      await expect(guarded.execute(verb, { id, body: { rank: 2 } })).rejects.toMatchObject({
        code: 'TRANSACTION_UNSUPPORTED',
      });
      expect(
        await database.prepare('SELECT rank, deletedAt FROM items WHERE id = ?').bind(id).first(),
      ).toEqual({ rank: 1, deletedAt: null });
    });
  }
}

it('rejects native D1 upserts with read pushdown before inserts or conflict updates', async () => {
  const guarded = defineResource('guarded', {
    model: defineModel({
      name: 'item',
      tableName: 'items',
      schema,
      id: 'client',
      timestamps: false,
      policies: { readPushdown: () => [{ field: 'rank', operator: 'eq', value: 99 }] },
    }),
    adapter: drizzleAdapter({ driver: 'd1', db, table, atomicUpsert: true }),
    upsert: { keys: ['id'] },
  });
  await database
    .prepare('INSERT INTO items (id, rank, tenantId) VALUES (?, 1, ?)')
    .bind('upsert-hidden', 'a')
    .run();
  for (const id of ['upsert-hidden', 'upsert-new']) {
    await expect(
      guarded.execute('upsert', { body: { id, rank: 2, tenantId: 'a' } }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_UNSUPPORTED' });
  }
  expect(
    await database.prepare("SELECT rank FROM items WHERE id = 'upsert-hidden'").first(),
  ).toEqual({ rank: 1 });
  expect(await database.prepare("SELECT id FROM items WHERE id = 'upsert-new'").first()).toBeNull();
});
