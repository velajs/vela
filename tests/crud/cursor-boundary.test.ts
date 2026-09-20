import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { defineModel, defineResource } from '@velajs/crud';
import { memoryAdapter, clearMemoryStorage } from '@velajs/crud-memory';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { encodeKeyset } from '@velajs/crud/query';

const schema = z.object({
  id: z.string(),
  rank: z.number().nullable(),
  tenantId: z.string(),
  visible: z.boolean(),
});
const table = sqliteTable('cursor_boundary', {
  id: text().primaryKey(),
  rank: integer(),
  tenantId: text().notNull(),
  visible: integer({ mode: 'boolean' }).notNull(),
});
const envelope = z.object({
  result: schema.array(),
  result_info: z.object({
    total_count: z.number(),
    next_cursor: z.string().optional(),
    has_next_page: z.boolean(),
  }),
});
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const close of disposers.splice(0)) close();
  clearMemoryStorage();
});

async function setup(kind: 'memory' | 'sqlite', readPolicy: boolean) {
  const client = kind === 'sqlite' ? createClient({ url: ':memory:' }) : undefined;
  if (client) {
    disposers.push(() => client.close());
    await client.execute(
      'CREATE TABLE cursor_boundary (id TEXT PRIMARY KEY, rank INTEGER, tenantId TEXT NOT NULL, visible INTEGER NOT NULL)',
    );
  }
  const adapter = client
    ? drizzleAdapter({ db: drizzle(client), table, parseRow: (value) => schema.parse(value) })
    : memoryAdapter({ tableName: 'cursor_boundary', parseRow: (value) => schema.parse(value) });
  const resource = defineResource('rows', {
    model: defineModel({
      name: 'row',
      tableName: 'cursor_boundary',
      schema,
      timestamps: false,
      id: 'client',
      multiTenant: true,
      ...(readPolicy ? { policies: { read: (_ctx, row) => schema.parse(row).visible } } : {}),
    }),
    adapter,
    pagination: { cursor: { enabled: true, field: 'rank' } },
  });
  await adapter.requestScope(async (scope) => {
    for (const row of [
      { id: 'b', rank: 1, tenantId: 'a', visible: true },
      { id: 'a', rank: 1, tenantId: 'a', visible: true },
      { id: 'c', rank: 2, tenantId: 'a', visible: true },
      { id: 'null', rank: null, tenantId: 'a', visible: true },
      { id: 'foreign', rank: 1, tenantId: 'b', visible: true },
      ...(readPolicy ? [{ id: 'hidden', rank: 1, tenantId: 'a', visible: false }] : []),
    ])
      await adapter.create(row, scope);
  });
  return { adapter, resource };
}

for (const kind of ['memory', 'sqlite'] as const)
  describe(`${kind} compound cursor engine`, () => {
    for (const readPolicy of [false, true])
      it(`visits ties once, tolerates deleted boundary, and scopes totals (policy=${readPolicy})`, async () => {
        const { adapter, resource } = await setup(kind, readPolicy);
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const result = await resource.execute('list', {
            query: { limit: '1', ...(cursor ? { cursor } : {}) },
            vars: { tenantId: 'a' },
          });
          const page = envelope.parse(result.body);
          expect(page.result_info.total_count).toBe(ids.length === 0 ? 4 : 3);
          ids.push(...page.result.map((row) => row.id));
          cursor = page.result_info.next_cursor;
          if (ids.length === 1)
            await adapter.requestScope((scope) =>
              adapter.delete({ field: 'id', value: 'null' }, {}, scope),
            );
          expect(ids.length).toBeLessThanOrEqual(4);
        } while (cursor);
        expect(ids).toEqual(['null', 'a', 'b', 'c']);
      });

    it('rejects malformed, scalar, wrong-order and wrong-type cursors before adapter access', async () => {
      const { adapter, resource } = await setup(kind, false);
      const list = vi.spyOn(adapter, 'list');
      const invalid = [
        '!!!',
        '',
        btoa('1'),
        encodeKeyset({ fields: ['id'], direction: 'asc' }, { id: 'a' }),
        encodeKeyset({ fields: ['rank', 'id'], direction: 'asc' }, { rank: 'wrong', id: 'a' }),
      ];
      for (const cursor of invalid) {
        await expect(
          resource.execute('list', { query: { cursor }, vars: { tenantId: 'a' } }),
        ).rejects.toThrow('Invalid cursor');
      }
      expect(list).not.toHaveBeenCalled();
    });

    it('list and read use ordinary request scopes', async () => {
      const { adapter, resource } = await setup(kind, false);
      const transaction = vi.spyOn(adapter, 'transaction');
      await resource.execute('list', { query: { limit: '1' }, vars: { tenantId: 'a' } });
      await resource.execute('read', { id: 'a', vars: { tenantId: 'a' } });
      expect(transaction).not.toHaveBeenCalled();
    });
  });
