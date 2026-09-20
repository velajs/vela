import { resolveKeyset } from '@velajs/crud/query';
/**
 * pg-dialect leg over PGlite (in-process Postgres): exercises the branches
 * the sqlite/libsql leg cannot — the pg substringMatch predicates
 * (POSITION/LOWER), real-Postgres RETURNING, unique violations surfacing as
 * `23505` / "duplicate key value violates unique constraint" → 409, plus the
 * dialect-generic paths (core five, restore, nested driver, tx rollback).
 * The mysql branches remain UNTESTED (no embeddable server) — documented in
 * PARITY.md.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { bigint, integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { AdapterScope } from '@velajs/crud/adapter';
import { drizzleAdapter } from '../adapter';

const items = pgTable('pg_items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  qty: integer('qty').notNull().default(0),
  tenantId: text('tenantId'),
  deletedAt: bigint('deletedAt', { mode: 'number' }),
});

const posts = pgTable('pg_posts', {
  id: text('id').primaryKey(),
  authorId: text('authorId'),
  title: text('title'),
  deletedAt: bigint('deletedAt', { mode: 'number' }),
});

const uniqItems = pgTable('pg_uniq_items', {
  id: text('id').primaryKey(),
  email: text('email'),
  authorId: text('authorId'),
  deletedAt: bigint('deletedAt', { mode: 'number' }),
});

const client = new PGlite();
const db = drizzle(client);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS pg_items (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0,
      "tenantId" TEXT, "deletedAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS pg_posts (
      id TEXT PRIMARY KEY, "authorId" TEXT, title TEXT, "deletedAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS pg_uniq_items (
      id TEXT PRIMARY KEY, email TEXT, "authorId" TEXT, "deletedAt" BIGINT, UNIQUE(email)
    );
    DELETE FROM pg_items; DELETE FROM pg_posts; DELETE FROM pg_uniq_items;
  `);
});

const makeAdapter = () =>
  drizzleAdapter({
    db,
    dialect: 'pg',
    table: items,
    softDeleteField: 'deletedAt',
    relations: {
      posts: { type: 'hasMany', table: posts, foreignKey: 'authorId' },
    },
  });

const scopeOf = async <T>(fn: (scope: AdapterScope) => Promise<T>): Promise<T> => {
  const adapter = makeAdapter();
  return adapter.transaction(fn);
};

describe('drizzleAdapter pg leg (PGlite)', () => {
  it('creates with RETURNING, reads, updates, soft-deletes, and restores', async () => {
    const adapter = makeAdapter();
    const row = await adapter.transaction((scope) =>
      adapter.create({ id: 'a', name: 'Anchor', qty: 2 }, scope),
    );
    expect(row).toMatchObject({ id: 'a', name: 'Anchor', qty: 2 });

    const updated = await scopeOf((s) =>
      adapter.update({ field: 'id', value: 'a' }, { qty: 9 }, s),
    );
    expect(updated?.qty).toBe(9);

    const deleted = await scopeOf((s) =>
      adapter.delete({ field: 'id', value: 'a' }, { softDeleteField: 'deletedAt' }, s),
    );
    expect(typeof deleted?.deletedAt).toBe('number');
    expect(await scopeOf((s) => adapter.readOne({ field: 'id', value: 'a' }, {}, s))).toBeNull();

    const restored = await scopeOf((s) => adapter.restore!({ field: 'id', value: 'a' }, s));
    expect(restored?.deletedAt).toBeNull();
  });

  it('substring filters use the pg POSITION/LOWER predicates (ilike + like)', async () => {
    const adapter = makeAdapter();
    await scopeOf((s) => adapter.create({ id: 'a', name: 'Anchor Rope' }, s));
    await scopeOf((s) => adapter.create({ id: 'b', name: 'buoy' }, s));

    const insensitive = await scopeOf((s) =>
      adapter.list(
        {
          filters: [{ field: 'name', operator: 'ilike', value: 'ANCHOR' }],
          options: { page: 1, per_page: 10 },
        },
        s,
      ),
    );
    expect(insensitive.result.map((r) => r.id)).toEqual(['a']);

    const sensitiveMiss = await scopeOf((s) =>
      adapter.list(
        {
          filters: [{ field: 'name', operator: 'like', value: 'anchor' }],
          options: { page: 1, per_page: 10 },
        },
        s,
      ),
    );
    expect(sensitiveMiss.result).toHaveLength(0);

    const sensitiveHit = await scopeOf((s) =>
      adapter.list(
        {
          filters: [{ field: 'name', operator: 'like', value: 'Anchor' }],
          options: { page: 1, per_page: 10 },
        },
        s,
      ),
    );
    expect(sensitiveHit.result.map((r) => r.id)).toEqual(['a']);
  });

  it('cursor pagination walks in cursor-field order with page 0', async () => {
    const adapter = makeAdapter();
    for (const id of ['c1', 'c2', 'c3']) {
      await scopeOf((s) => adapter.create({ id, name: `Row ${id}` }, s));
    }
    const first = await scopeOf((s) =>
      adapter.list(
        { filters: [], options: { limit: 2, keyset: resolveKeyset(undefined, ['id'], 'asc') } },
        s,
      ),
    );
    expect(first.result.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(first.result_info.page).toBe(0);
    expect(first.result_info.next_cursor).toBeDefined();
  });

  it('maps pg unique violations (23505 / duplicate key message) to 409', async () => {
    const adapter = drizzleAdapter({
      db,
      dialect: 'pg',
      table: uniqItems,
      softDeleteField: 'deletedAt',
    });
    await adapter.transaction((s) => adapter.create({ id: '1', email: 'a@x' }, s));
    await expect(
      adapter.transaction((s) => adapter.create({ id: '2', email: 'a@x' }, s)),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    await expect(
      adapter.transaction(async (s) => {
        await adapter.create({ id: '3', email: 'b@x' }, s);
        return adapter.update({ field: 'id', value: '3' }, { email: 'a@x' }, s);
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('nested driver stamps the FK and maps related unique violations', async () => {
    const adapter = drizzleAdapter({
      db,
      dialect: 'pg',
      table: items,
      softDeleteField: 'deletedAt',
      relations: {
        uniq: { type: 'hasMany', table: uniqItems, foreignKey: 'authorId' },
      },
    });
    await adapter.transaction(async (s) => {
      await adapter.create({ id: 'u1', name: 'U' }, s);
      await adapter.nested!.createNested({ id: 'u1' }, 'uniq', [{ id: 'q1', email: 'dup@x' }], s);
    });
    const rows = (await db.select().from(uniqItems)) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ id: 'q1', authorId: 'u1' });

    await expect(
      adapter.transaction((s) =>
        adapter.nested!.createNested({ id: 'u1' }, 'uniq', [{ id: 'q2', email: 'dup@x' }], s),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('rolls back the transaction when the callback throws (real pg tx)', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.transaction(async (scope) => {
        await adapter.create({ id: 'ghost', name: 'Ghost' }, scope);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(
      await scopeOf((s) => adapter.readOne({ field: 'id', value: 'ghost' }, {}, s)),
    ).toBeNull();
  });
});
