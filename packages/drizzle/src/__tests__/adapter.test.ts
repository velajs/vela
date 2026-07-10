import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AdapterScope } from '@velajs/crud/adapter';
import { drizzleAdapter } from '../adapter';
import { DrizzleAuditStore, DrizzleVersioningStore } from '../stores';

const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  qty: integer('qty').notNull().default(0),
  tenantId: text('tenantId'),
  deletedAt: integer('deletedAt'),
});

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  authorId: text('authorId'),
  title: text('title'),
  deletedAt: integer('deletedAt'),
});

const versions = sqliteTable('versions', {
  id: text('id').primaryKey(),
  tableName: text('tableName').notNull(),
  recordId: text('recordId').notNull(),
  version: integer('version').notNull(),
  data: text('data').notNull(),
  createdAt: integer('createdAt').notNull(),
  changedBy: text('changedBy'),
  changeReason: text('changeReason'),
});

const audits = sqliteTable('audits', {
  id: text('id').primaryKey(),
  timestamp: integer('timestamp').notNull(),
  action: text('action').notNull(),
  tableName: text('tableName').notNull(),
  recordId: text('recordId').notNull(),
  userId: text('userId'),
  record: text('record'),
  previousRecord: text('previousRecord'),
  changes: text('changes'),
  metadata: text('metadata'),
});

let client: Client;
let db: ReturnType<typeof drizzle>;

// libsql transactions open a NEW connection to the url; with `:memory:` that
// is a DIFFERENT empty database (the caveat hono-crud's drizzle tests hit).
// File-backed per-test databases keep transactions on the same store.
const tmpDir = mkdtempSync(join(tmpdir(), 'crud-drizzle-'));
let dbCounter = 0;

afterAll(() => {
  client?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function freshDb() {
  client?.close();
  client = createClient({ url: `file:${join(tmpDir, `t${++dbCounter}.db`)}` });
  db = drizzle(client);
  await client.execute(
    'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, tenantId TEXT, deletedAt INTEGER)',
  );
  await client.execute(
    'CREATE TABLE posts (id TEXT PRIMARY KEY, authorId TEXT, title TEXT, deletedAt INTEGER)',
  );
  await client.execute(
    'CREATE TABLE versions (id TEXT PRIMARY KEY, tableName TEXT NOT NULL, recordId TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL, changedBy TEXT, changeReason TEXT)',
  );
  await client.execute(
    'CREATE TABLE audits (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, action TEXT NOT NULL, tableName TEXT NOT NULL, recordId TEXT NOT NULL, userId TEXT, record TEXT, previousRecord TEXT, changes TEXT, metadata TEXT)',
  );
}

const makeAdapter = () =>
  drizzleAdapter({
    db,
    dialect: 'sqlite',
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

beforeEach(async () => {
  await freshDb();
});

describe('drizzleAdapter core', () => {
  it('creates with RETURNING and reads back', async () => {
    const adapter = makeAdapter();
    const row = await adapter.transaction((scope) =>
      adapter.create({ id: 'a', name: 'Anchor', qty: 2 }, scope),
    );
    expect(row).toMatchObject({ id: 'a', name: 'Anchor', qty: 2 });

    const read = await adapter.transaction((scope) =>
      adapter.readOne({ field: 'id', value: 'a' }, {}, scope),
    );
    expect(read?.name).toBe('Anchor');
  });

  it('enforces lookup filters and soft-delete visibility', async () => {
    const adapter = makeAdapter();
    await scopeOf((s) => adapter.create({ id: 'a', name: 'A', tenantId: 't1' }, s));
    await scopeOf((s) => adapter.create({ id: 'b', name: 'B', deletedAt: 5 }, s));

    expect(
      await scopeOf((s) => adapter.readOne({ field: 'id', value: 'a', filters: { tenantId: 't2' } }, {}, s)),
    ).toBeNull();
    expect(await scopeOf((s) => adapter.readOne({ field: 'id', value: 'b' }, {}, s))).toBeNull();
    expect(
      await scopeOf((s) => adapter.readOne({ field: 'id', value: 'b' }, { withDeleted: true }, s)),
    ).toMatchObject({ id: 'b' });
  });

  it('updates, soft-deletes, and restores', async () => {
    const adapter = makeAdapter();
    await scopeOf((s) => adapter.create({ id: 'a', name: 'A', qty: 1 }, s));

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
    // restore of a not-deleted row → null
    expect(await scopeOf((s) => adapter.restore!({ field: 'id', value: 'a' }, s))).toBeNull();
  });

  it('forwards TransactionContext to onOpenTransaction at tx open', async () => {
    const seen: Array<{ tx: unknown; tenantId?: string }> = [];
    const adapter = drizzleAdapter({
      db,
      dialect: 'sqlite',
      table: items,
      softDeleteField: 'deletedAt',
      onOpenTransaction: (tx, ctx) => {
        seen.push({ tx, tenantId: ctx.tenantId });
      },
    });

    await adapter.transaction(
      (scope) => adapter.create({ id: 'ctx1', name: 'Scoped' }, scope),
      { tenantId: 't1' },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tenantId).toBe('t1');
    expect(seen[0]!.tx).not.toBeNull();

    // Direct adapter use without a context: the hook is not invoked.
    await adapter.transaction((scope) => adapter.readOne({ field: 'id', value: 'ctx1' }, {}, scope));
    expect(seen).toHaveLength(1);
  });

  it('rolls back the transaction when the callback throws', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.transaction(async (scope) => {
        await adapter.create({ id: 'tx1', name: 'Ghost' }, scope);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await scopeOf((s) => adapter.readOne({ field: 'id', value: 'tx1' }, {}, s))).toBeNull();
  });
});

describe('drizzleAdapter list', () => {
  beforeEach(async () => {
    const adapter = makeAdapter();
    await adapter.transaction(async (s) => {
      await adapter.create({ id: 'a', name: 'Anchor', qty: 5 }, s);
      await adapter.create({ id: 'b', name: 'Berth', qty: 10 }, s);
      await adapter.create({ id: 'c', name: 'Crane', qty: 15 }, s);
      await adapter.create({ id: 'd', name: 'Dock', qty: 20, deletedAt: 111 }, s);
    });
  });

  it('applies the 12-operator filters with soft-delete visibility', async () => {
    const adapter = makeAdapter();
    const page = await scopeOf((s) =>
      adapter.list({ filters: [{ field: 'qty', operator: 'gte', value: 10 }], options: {} }, s),
    );
    expect(page.result.map((r) => r.id)).toEqual(['b', 'c']);
    expect(page.result_info.total_count).toBe(2);

    const like = await scopeOf((s) =>
      adapter.list({ filters: [{ field: 'name', operator: 'ilike', value: 'AN%' }], options: {} }, s),
    );
    // literal needle: % stripped → matches Anchor and Crane ('an' substring)
    expect(like.result.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('searches configured fields with a case-insensitive literal needle', async () => {
    const adapter = makeAdapter();
    const page = await scopeOf((s) =>
      adapter.list({ filters: [], options: { search: 'an', searchFields: ['name'] } }, s),
    );
    expect(page.result.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('sorts and offset-paginates', async () => {
    const adapter = makeAdapter();
    const page = await scopeOf((s) =>
      adapter.list(
        { filters: [], options: { order_by: 'qty', order_by_direction: 'desc', page: 2, per_page: 2 } },
        s,
      ),
    );
    expect(page.result.map((r) => r.id)).toEqual(['a']);
    expect(page.result_info).toMatchObject({ page: 2, total_pages: 2, has_prev_page: true });
  });

  it('walks keyset cursors next-only with page 0', async () => {
    const adapter = makeAdapter();
    const first = await scopeOf((s) =>
      adapter.list({ filters: [], options: { limit: 2, order_by: 'id' } }, s),
    );
    expect(first.result.map((r) => r.id)).toEqual(['a', 'b']);
    expect(first.result_info).toMatchObject({ page: 0, has_next_page: true, has_prev_page: false });

    const second = await scopeOf((s) =>
      adapter.list(
        { filters: [], options: { limit: 2, order_by: 'id', cursor: first.result_info.next_cursor } },
        s,
      ),
    );
    expect(second.result.map((r) => r.id)).toEqual(['c']);
    expect(second.result_info).toMatchObject({ page: 0, has_next_page: false, has_prev_page: true });
  });
});

describe('drizzleAdapter bulk + aggregate + drivers', () => {
  it('updateWhere patches matching rows and returns them', async () => {
    const adapter = makeAdapter();
    await adapter.transaction(async (s) => {
      await adapter.create({ id: 'a', name: 'A', qty: 1 }, s);
      await adapter.create({ id: 'b', name: 'B', qty: 1 }, s);
      await adapter.create({ id: 'c', name: 'C', qty: 9 }, s);
    });
    const outcome = await scopeOf((s) =>
      adapter.updateWhere!([{ field: 'qty', operator: 'eq', value: 1 }], { qty: 2 }, s),
    );
    expect(outcome.count).toBe(2);
    expect(outcome.records?.every((r) => r.qty === 2)).toBe(true);
  });

  it('createMany inserts with RETURNING', async () => {
    const adapter = makeAdapter();
    const rows = await scopeOf((s) =>
      adapter.createMany!([{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }], s),
    );
    expect(rows.map((r) => r.id)).toEqual(['x', 'y']);
  });

  it('aggregates multi-op with aliases and grouping', async () => {
    const adapter = makeAdapter();
    await adapter.transaction(async (s) => {
      await adapter.create({ id: 'a', name: 'A', qty: 10, tenantId: 't1' }, s);
      await adapter.create({ id: 'b', name: 'B', qty: 20, tenantId: 't1' }, s);
      await adapter.create({ id: 'c', name: 'C', qty: 5, tenantId: 't2' }, s);
    });

    const flat = await scopeOf((s) =>
      adapter.aggregate!(
        {
          operation: 'count',
          field: '*',
          filters: [],
          aggregations: [
            { operation: 'count', field: '*' },
            { operation: 'sum', field: 'qty' },
          ],
        },
        s,
      ),
    );
    expect(flat.values).toMatchObject({ count: 3, sumQty: 35 });

    const grouped = await scopeOf((s) =>
      adapter.aggregate!(
        {
          operation: 'sum',
          field: 'qty',
          filters: [],
          aggregations: [{ operation: 'sum', field: 'qty' }],
          groupBy: ['tenantId'],
        },
        s,
      ),
    );
    expect(grouped.totalGroups).toBe(2);
    const t1 = grouped.groups?.find((g) => g.key.tenantId === 't1');
    expect(t1?.values.sumQty).toBe(30);
  });

  it('relation loader groups with owner-scope pushdown; cascade counts/deletes/nullifies', async () => {
    const adapter = makeAdapter();
    await scopeOf((s) => adapter.create({ id: 'u1', name: 'U1' }, s));
    // Seed the related table outside any adapter transaction — a write on the
    // outer connection while a tx holds the lock fails on libsql.
    await db.insert(posts).values([
      { id: 'p1', authorId: 'u1', title: 'One' },
      { id: 'p2', authorId: 'u1', title: 'Two', deletedAt: 4 },
      { id: 'p3', authorId: 'zz', title: 'Other' },
    ]);

    const loaded = await scopeOf((s) =>
      adapter.relations!.load([{ id: 'u1' }], 'posts', { excludeDeletedField: 'deletedAt' }, s),
    );
    expect(loaded.get('u1')).toHaveLength(1);

    expect(await scopeOf((s) => adapter.cascade!.countRelated('posts', 'u1', s))).toBe(2);
    expect(await scopeOf((s) => adapter.cascade!.nullifyRelated('posts', 'zz', s))).toBe(1);
    expect(await scopeOf((s) => adapter.cascade!.deleteRelated('posts', 'u1', s))).toBe(2);
  });
});

describe('Drizzle stores', () => {
  it('versioning store round-trips entries newest-first with latest()', async () => {
    const store = new DrizzleVersioningStore(db, versions);
    await store.save('items', {
      id: 'v1',
      recordId: 'a',
      version: 1,
      data: { name: 'One' },
      createdAt: new Date(1000),
    });
    await store.save('items', {
      id: 'v2',
      recordId: 'a',
      version: 2,
      data: { name: 'Two' },
      createdAt: new Date(2000),
      changedBy: 'user-1',
    });

    expect(await store.latest('items', 'a')).toBe(2);
    const list = await store.list('items', 'a');
    expect(list.map((e) => e.version)).toEqual([2, 1]);
    const v1 = await store.get('items', 'a', 1);
    expect(v1?.data).toEqual({ name: 'One' });
    expect(await store.get('items', 'a', 9)).toBeNull();
    expect(await store.deleteAll('items', 'a')).toBe(2);
    expect(await store.latest('items', 'a')).toBe(0);
  });

  it('audit store logs, batches, and queries newest-first with filters', async () => {
    const store = new DrizzleAuditStore(db, audits);
    await store.log({
      id: 'e1',
      timestamp: new Date(1000),
      action: 'create',
      tableName: 'items',
      recordId: 'a',
      record: { name: 'A' },
    });
    await store.logBatch([
      {
        id: 'e2',
        timestamp: new Date(2000),
        action: 'update',
        tableName: 'items',
        recordId: 'a',
        userId: 'u1',
        previousRecord: { name: 'A' },
        record: { name: 'B' },
        changes: [{ field: 'name', oldValue: 'A', newValue: 'B' }],
      },
      { id: 'e3', timestamp: new Date(3000), action: 'delete', tableName: 'other', recordId: 'z' },
    ]);

    const all = await store.query();
    expect(all.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
    const filtered = await store.query({ tableName: 'items', action: 'update' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.changes?.[0]).toMatchObject({ field: 'name', newValue: 'B' });
  });
});
