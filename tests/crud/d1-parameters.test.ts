import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { drizzle } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { z } from 'zod';
import { defineModel, defineResource } from '@velajs/crud';

const parents = sqliteTable('parents', { id: text().primaryKey() });
const children = sqliteTable('children', {
  id: text().primaryKey(),
  parentId: text().notNull(),
  tenantId: text().notNull(),
  label: text().notNull(),
  deletedAt: integer(),
});
const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'crud-d1-parameters',
        type: 'worker',
        compatibilityDate: '2026-09-20',
        manifest: {
          mainModule: 'worker.js',
          modules: {
            'worker.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("ok"); } };',
            },
          },
        },
        env: { DB: { type: 'd1', id: 'crud-d1-parameters' } },
      },
    },
  ],
});
const database = await runtime.getD1Database('DB');
const statements: { sql: string; count: number }[] = [];
const db = drizzle(database, {
  schema: { parents, children },
  logger: {
    logQuery(sql, params) {
      statements.push({ sql, count: params.length });
    },
  },
});
const adapter = drizzleAdapter({
  driver: 'd1',
  db,
  table: parents,
  relations: {
    children: { type: 'hasMany', table: children, foreignKey: 'parentId' },
  },
});
const childAdapter = drizzleAdapter({ driver: 'd1', db, table: children });
const rows = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}` }));
beforeAll(async () => {
  await database.exec(
    'CREATE TABLE parents (id TEXT PRIMARY KEY); CREATE TABLE children (id TEXT PRIMARY KEY, parentId TEXT NOT NULL, tenantId TEXT NOT NULL, label TEXT NOT NULL, deletedAt INTEGER)',
  );
  const childValues = rows.flatMap(({ id }) => [
    `('${id}-a', '${id}', 'a', 'visible', NULL)`,
    `('${id}-b', '${id}', 'b', 'visible', NULL)`,
    `('${id}-deleted', '${id}', 'a', 'visible', 1)`,
    `('${id}-hidden', '${id}', 'a', 'hidden', NULL)`,
  ]);
  // One exec: each proxied prepare()/bind() is a synchronous round trip; 1000 of them overran 10s.
  await database.exec(
    `INSERT INTO parents VALUES ${rows.map(({ id }) => `('${id}')`).join(', ')}; ` +
      `INSERT INTO children VALUES ${childValues.join(', ')}`,
  );
});
afterAll(() => runtime.dispose());

describe('D1 parameter budgets', () => {
  it('chunks 100 parent IDs while repeating exact tenant, policy and deleted predicates', async () => {
    statements.length = 0;
    const grouped = await adapter.requestScope((scope) =>
      adapter.relations!.load(
        [...rows, rows[0]!, { id: null }],
        'children',
        {
          tenantField: 'tenantId',
          tenantValue: 'a',
          excludeDeletedField: 'deletedAt',
          predicate: { op: 'startsWith', field: 'label', value: 'vis' },
        },
        scope,
      ),
    );
    expect([...grouped.keys()].toSorted()).toEqual(rows.map((row) => row.id).toSorted());
    for (const row of rows)
      expect(grouped.get(row.id)?.map((child) => child.id)).toEqual([`${row.id}-a`]);
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => statement.count <= 100)).toBe(true);
    expect(
      statements.every(
        (statement) =>
          statement.sql.includes('"tenantId"') &&
          statement.sql.includes('"deletedAt"') &&
          statement.sql.toLowerCase().includes('substr('),
      ),
    ).toBe(true);
  });

  it.each([99, 100])('loads %i IDs with exact tenant budget', async (count) => {
    statements.length = 0;
    const grouped = await adapter.requestScope((scope) =>
      adapter.relations!.load(
        rows.slice(0, count),
        'children',
        { tenantField: 'tenantId', tenantValue: 'a', excludeDeletedField: 'deletedAt' },
        scope,
      ),
    );
    expect(grouped.size).toBe(count);
    expect(statements).toHaveLength(count === 99 ? 1 : 2);
    expect(statements[0]?.count).toBe(100);
  });

  it('preserves resource totals, page boundaries and includes across chunks', async () => {
    const childSchema = z.object({
      id: z.string(),
      parentId: z.string(),
      tenantId: z.string(),
      label: z.string(),
      deletedAt: z.number().nullable(),
    });
    const model = defineModel({
      name: 'parent',
      tableName: 'parents',
      timestamps: false,
      schema: z.object({ id: z.string() }),
      relations: {
        children: {
          type: 'hasMany',
          target: 'children',
          foreignKey: 'parentId',
          schema: childSchema,
          response: {
            tenantField: 'tenantId',
            softDeleteField: 'deletedAt',
            authorization: () => ({
              kind: 'conditional',
              predicate: { op: 'eq', field: 'label', value: 'visible' },
            }),
          },
        },
      },
    });
    const resource = defineResource('parents', {
      model,
      adapter,
      allowedIncludes: ['children'],
      sortFields: ['id'],
    });
    const decode = z.object({
      result: z.array(z.object({ id: z.string(), children: childSchema.array() })),
      result_info: z.object({ total_count: z.number(), has_next_page: z.boolean() }),
    });
    statements.length = 0;
    const first = decode.parse(
      (
        await resource.execute('list', {
          query: { include: 'children', per_page: '100', order_by: 'id' },
          vars: { tenantId: 'a' },
        })
      ).body,
    );
    expect(first.result).toHaveLength(100);
    expect(first.result_info).toEqual({ total_count: 100, has_next_page: false });
    expect(
      first.result.every(
        (row) => row.children.length === 1 && row.children[0]?.id === row.id + '-a',
      ),
    ).toBe(true);
    const second = decode.parse(
      (
        await resource.execute('list', {
          query: { include: 'children', page: '2', per_page: '99', order_by: 'id' },
          vars: { tenantId: 'a' },
        })
      ).body,
    );
    expect(second.result).toHaveLength(1);
    expect(second.result[0]?.id).toBe(first.result[99]?.id);
    expect(second.result_info.total_count).toBe(100);
    expect(statements.every((statement) => statement.count <= 100)).toBe(true);
  });

  it('reserves pagination parameters and rejects an exhausted relation scope before queries', async () => {
    statements.length = 0;
    await expect(
      childAdapter.requestScope((scope) =>
        childAdapter.list(
          {
            filters: [
              { field: 'parentId', operator: 'in', value: rows.slice(0, 99).map((row) => row.id) },
            ],
            options: { page: 2, per_page: 1 },
          },
          scope,
        ),
      ),
    ).rejects.toMatchObject({ code: 'QUERY_PARAMETER_LIMIT' });
    expect(statements).toEqual([]);
    await expect(
      adapter.requestScope((scope) =>
        adapter.relations!.load(
          rows,
          'children',
          {
            predicate: {
              op: 'in',
              field: 'label',
              values: Array.from({ length: 100 }, (_, i) => String(i)),
            },
          },
          scope,
        ),
      ),
    ).rejects.toMatchObject({ code: 'QUERY_PARAMETER_LIMIT' });
    expect(statements).toEqual([]);
  });

  it('preflights all D1 upsert statements and rejects oversized writes atomically', async () => {
    statements.length = 0;
    const atomic = drizzleAdapter({ driver: 'd1', db, table: children, atomicUpsert: true });
    await expect(
      atomic.requestScope((scope) =>
        atomic.upsertOne!(
          {
            values: { id: 'new', parentId: 'p0', tenantId: 'a', label: 'new' },
            conflictTarget: ['id'],
            scope: [{ field: 'parentId', operator: 'in', value: rows.map((row) => row.id) }],
          },
          scope,
        ),
      ),
    ).rejects.toMatchObject({ code: 'QUERY_PARAMETER_LIMIT' });
    expect(statements).toEqual([]);
    expect(
      await database.prepare('SELECT id FROM children WHERE id = ?').bind('new').first(),
    ).toBeNull();
    await expect(
      childAdapter.requestScope((scope) =>
        childAdapter.createMany!(
          Array.from({ length: 26 }, (_, i) => ({
            id: 'extra' + i,
            parentId: 'p0',
            tenantId: 'a',
            label: 'new',
          })),
          scope,
        ),
      ),
    ).rejects.toMatchObject({ code: 'QUERY_PARAMETER_LIMIT' });
    expect(statements).toEqual([]);
  });

  it('rejects oversized ordinary predicates without executing or splitting pagination', async () => {
    statements.length = 0;
    await expect(
      childAdapter.requestScope((scope) =>
        childAdapter.list(
          {
            filters: [
              {
                field: 'parentId',
                operator: 'in',
                value: Array.from({ length: 101 }, (_, i) => `p${i}`),
              },
            ],
            options: { page: 1, per_page: 10 },
          },
          scope,
        ),
      ),
    ).rejects.toMatchObject({ code: 'QUERY_PARAMETER_LIMIT' });
    expect(statements).toEqual([]);
  });
});

it('compiles generated insert defaults once and executes the checked statement', async () => {
  let defaults = 0;
  const generated = sqliteTable('generated', {
    id: text()
      .primaryKey()
      .$defaultFn(() => 'generated-' + ++defaults),
  });
  await database.exec('CREATE TABLE generated (id TEXT PRIMARY KEY)');
  const generatedAdapter = drizzleAdapter({ driver: 'd1', db, table: generated });
  const row = await generatedAdapter.requestScope((scope) => generatedAdapter.create({}, scope));
  expect(defaults).toBe(1);
  expect(row).toEqual({ id: 'generated-1' });
});

it('preserves prepared defaults and row mapping through atomic upsert batches', async () => {
  let defaults = 0;
  const generated = sqliteTable('batch_defaults', {
    id: text().primaryKey(),
    value: integer().notNull(),
    stamp: text().$defaultFn(() => 'stamp-' + ++defaults),
  });
  await database.exec(
    'CREATE TABLE batch_defaults (id TEXT PRIMARY KEY, value INTEGER, stamp TEXT)',
  );
  const atomic = drizzleAdapter({ driver: 'd1', db, table: generated, atomicUpsert: true });
  const created = await atomic.requestScope((scope) =>
    atomic.upsertOne!({ values: { id: 'one', value: 1 }, conflictTarget: ['id'] }, scope),
  );
  expect(defaults).toBe(1);
  expect(created).toEqual({ created: true, row: { id: 'one', value: 1, stamp: 'stamp-1' } });
  const updated = await atomic.requestScope((scope) =>
    atomic.upsertOne!({ values: { id: 'one', value: 2 }, conflictTarget: ['id'] }, scope),
  );
  expect(defaults).toBe(2);
  expect(updated).toEqual({ created: false, row: { id: 'one', value: 2, stamp: 'stamp-1' } });
});
