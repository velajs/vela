import { beforeEach, describe, expect, it } from 'vitest';
import type { AdapterScope } from '@velajs/crud/adapter';
import { MEMORY_NOOP_TX, memoryAdapter } from '../adapter';
import { clearMemoryStorage, getStore } from '../storage';

const scope: AdapterScope = { tx: MEMORY_NOOP_TX };

const users = () =>
  memoryAdapter({
    tableName: 'users',
    softDeleteField: 'deletedAt',
    relations: {
      posts: { type: 'hasMany', table: 'posts', foreignKey: 'authorId' },
      profile: { type: 'hasOne', table: 'profiles', foreignKey: 'userId' },
    },
  });

beforeEach(() => {
  clearMemoryStorage();
});

function seed(rows: Array<Record<string, unknown>>, table = 'users'): void {
  const store = getStore(table);
  for (const row of rows) store.set(String(row.id), row);
}

describe('memoryAdapter core methods', () => {
  it('unique tuples: create/update violations 409; tombstones occupy; nulls never conflict', async () => {
    const adapter = memoryAdapter({
      tableName: 'uniq',
      primaryKey: 'id',
      softDeleteField: 'deletedAt',
      unique: [['email']],
    });
    await adapter.create({ id: '1', email: 'a@x' }, scope);
    await expect(adapter.create({ id: '2', email: 'a@x' }, scope)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    await adapter.create({ id: '3', email: 'b@x' }, scope);
    await expect(
      adapter.update({ field: 'id', value: '3' }, { email: 'a@x' }, scope),
    ).rejects.toMatchObject({ statusCode: 409 });
    // A self-update to the SAME value never conflicts with itself.
    await adapter.update({ field: 'id', value: '1' }, { email: 'a@x' }, scope);
    // SQL semantics: null values never occupy the slot — and a LITERAL
    // 'null' string never collides with an actual null.
    await adapter.create({ id: '4', email: null }, scope);
    await adapter.create({ id: '5', email: null }, scope);
    await adapter.create({ id: '5b', email: 'null' }, scope);
    // Soft-deleted rows still occupy (non-partial-index semantics).
    await adapter.delete({ field: 'id', value: '1' }, { softDeleteField: 'deletedAt' }, scope);
    await expect(adapter.create({ id: '6', email: 'a@x' }, scope)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('create stores the row keyed by primary key', async () => {
    const adapter = users();
    const row = await adapter.create({ id: 'u1', name: 'Ada' }, scope);
    expect(row).toEqual({ id: 'u1', name: 'Ada' });
    expect(getStore('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' });
  });

  it('declares uniqueConstraints only when tuples are configured (loud define-time pairing)', () => {
    expect(users().capabilities.has('uniqueConstraints')).toBe(false);
    expect(
      memoryAdapter({ tableName: 'u2', unique: [['email']] }).capabilities.has('uniqueConstraints'),
    ).toBe(true);
  });

  it('nested driver: createNested stamps the FK; applyNested ops are FK-scoped', async () => {
    const adapter = users();
    seed([{ id: 'u1' }]);
    await adapter.nested!.createNested({ id: 'u1' }, 'posts', [{ title: 'P' }], scope);
    const created = [...getStore('posts').values()];
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: 'P', authorId: 'u1' });

    seed(
      [
        { id: 'p1', authorId: 'u1', title: 'Mine' },
        { id: 'p2', authorId: 'u1', title: 'Del' },
        { id: 'p3', authorId: null, title: 'Free' },
        { id: 'p4', authorId: 'u1', title: 'Off' },
      ],
      'posts',
    );
    await adapter.nested!.applyNested(
      { id: 'u1' },
      'posts',
      {
        update: [{ where: { id: 'p1' }, data: { title: 'Mine2' } }],
        delete: [{ id: 'p2' }],
        connect: [{ id: 'p3' }],
        disconnect: [{ id: 'p4' }],
      },
      scope,
    );
    const posts = getStore('posts');
    expect(posts.get('p1')).toMatchObject({ title: 'Mine2' });
    expect(posts.has('p2')).toBe(false);
    expect(posts.get('p3')).toMatchObject({ authorId: 'u1' });
    expect(posts.get('p4')).toMatchObject({ authorId: null });

    // set = disconnect everything, then relink exactly the listed records.
    await adapter.nested!.applyNested({ id: 'u1' }, 'posts', { set: [{ id: 'p4' }] }, scope);
    expect(posts.get('p1')).toMatchObject({ authorId: null });
    expect(posts.get('p4')).toMatchObject({ authorId: 'u1' });
  });

  it('create throws ConflictException (409) on a duplicate primary key', async () => {
    const adapter = users();
    await adapter.create({ id: 'u1', name: 'Ada' }, scope);
    await expect(adapter.create({ id: 'u1', name: 'Eve' }, scope)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(getStore('users').get('u1')).toMatchObject({ name: 'Ada' });
  });

  it('transaction accepts a TransactionContext and runs fn unchanged', async () => {
    const adapter = users();
    const result = await adapter.transaction(
      async (s) => adapter.create({ id: 'u9', name: 'Tx' }, s),
      { tenantId: 't1' },
    );
    expect(result).toMatchObject({ id: 'u9' });
    expect(getStore('users').get('u9')).toBeDefined();
  });

  it('readOne finds by primary key and by secondary field', async () => {
    const adapter = users();
    seed([{ id: 'u1', email: 'ada@example.com' }]);
    expect(await adapter.readOne({ field: 'id', value: 'u1' }, {}, scope)).toMatchObject({
      id: 'u1',
    });
    expect(
      await adapter.readOne({ field: 'email', value: 'ada@example.com' }, {}, scope),
    ).toMatchObject({ id: 'u1' });
    expect(await adapter.readOne({ field: 'id', value: 'nope' }, {}, scope)).toBeNull();
  });

  it('readOne enforces lookup filters (tenant scoping shape)', async () => {
    const adapter = users();
    seed([{ id: 'u1', tenantId: 't1' }]);
    expect(
      await adapter.readOne({ field: 'id', value: 'u1', filters: { tenantId: 't1' } }, {}, scope),
    ).toMatchObject({ id: 'u1' });
    expect(
      await adapter.readOne({ field: 'id', value: 'u1', filters: { tenantId: 't2' } }, {}, scope),
    ).toBeNull();
  });

  it('readOne hides soft-deleted rows unless withDeleted', async () => {
    const adapter = users();
    seed([{ id: 'u1', deletedAt: 123 }]);
    expect(await adapter.readOne({ field: 'id', value: 'u1' }, {}, scope)).toBeNull();
    expect(
      await adapter.readOne({ field: 'id', value: 'u1' }, { withDeleted: true }, scope),
    ).toMatchObject({ id: 'u1' });
  });

  it('update merges the patch and refuses soft-deleted rows', async () => {
    const adapter = users();
    seed([
      { id: 'u1', name: 'Ada' },
      { id: 'u2', name: 'Bob', deletedAt: 1 },
    ]);
    expect(await adapter.update({ field: 'id', value: 'u1' }, { name: 'Ada L.' }, scope)).toEqual({
      id: 'u1',
      name: 'Ada L.',
    });
    expect(await adapter.update({ field: 'id', value: 'u2' }, { name: 'X' }, scope)).toBeNull();
  });

  it('delete hard-removes without softDeleteField and stamps with it', async () => {
    const adapter = users();
    seed([
      { id: 'u1', name: 'Ada' },
      { id: 'u2', name: 'Bob' },
    ]);
    const hard = await adapter.delete({ field: 'id', value: 'u1' }, {}, scope);
    expect(hard).toMatchObject({ id: 'u1' });
    expect(getStore('users').has('u1')).toBe(false);

    const soft = await adapter.delete(
      { field: 'id', value: 'u2' },
      { softDeleteField: 'deletedAt' },
      scope,
    );
    expect(soft).toMatchObject({ id: 'u2' });
    expect(typeof (getStore('users').get('u2') as Record<string, unknown>).deletedAt).toBe(
      'number',
    );
  });

  it('transaction passes the frozen no-op sentinel scope', async () => {
    const adapter = users();
    const seen = await adapter.transaction(async (s) => s.tx);
    expect(seen).toBe(MEMORY_NOOP_TX);
  });
});

describe('memoryAdapter list', () => {
  beforeEach(() => {
    seed([
      { id: 'a', name: 'Anchor', qty: 5 },
      { id: 'b', name: 'Berth', qty: 10 },
      { id: 'c', name: 'Crane', qty: 15 },
      { id: 'd', name: 'Dock', qty: 20, deletedAt: 111 },
    ]);
  });

  it('applies filters, hides soft-deleted by default, and paginates', async () => {
    const adapter = users();
    const page = await adapter.list(
      { filters: [{ field: 'qty', operator: 'gte', value: 10 }], options: {} },
      scope,
    );
    expect(page.result.map((r) => r.id)).toEqual(['b', 'c']);
    expect(page.result_info).toMatchObject({
      page: 1,
      per_page: 20,
      total_count: 2,
      has_next_page: false,
      has_prev_page: false,
    });
  });

  it('honors withDeleted / onlyDeleted visibility', async () => {
    const adapter = users();
    const withDeleted = await adapter.list({ filters: [], options: { withDeleted: true } }, scope);
    expect(withDeleted.result).toHaveLength(4);
    const onlyDeleted = await adapter.list({ filters: [], options: { onlyDeleted: true } }, scope);
    expect(onlyDeleted.result.map((r) => r.id)).toEqual(['d']);
  });

  it('sorts and offset-paginates with page metadata', async () => {
    const adapter = users();
    const page = await adapter.list(
      {
        filters: [],
        options: { order_by: 'qty', order_by_direction: 'desc', page: 2, per_page: 2 },
      },
      scope,
    );
    expect(page.result.map((r) => r.id)).toEqual(['a']);
    expect(page.result_info).toMatchObject({
      page: 2,
      per_page: 2,
      total_count: 3,
      total_pages: 2,
      has_next_page: false,
      has_prev_page: true,
    });
  });

  it('searches configured fields with a literal case-insensitive needle', async () => {
    const adapter = users();
    const page = await adapter.list(
      { filters: [], options: { search: 'an', searchFields: ['name'] } },
      scope,
    );
    expect(page.result.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('walks pages with a keyset cursor (next-only, strictly-after boundary)', async () => {
    const adapter = users();
    const first = await adapter.list({ filters: [], options: { limit: 2, order_by: 'id' } }, scope);
    expect(first.result.map((r) => r.id)).toEqual(['a', 'b']);
    expect(first.result_info.has_next_page).toBe(true);
    expect(first.result_info.next_cursor).toBeDefined();

    const second = await adapter.list(
      { filters: [], options: { limit: 2, order_by: 'id', cursor: first.result_info.next_cursor } },
      scope,
    );
    expect(second.result.map((r) => r.id)).toEqual(['c']);
    expect(second.result_info.has_next_page).toBe(false);
    expect(second.result_info.next_cursor).toBeUndefined();
    expect(second.result_info.has_prev_page).toBe(true);
  });
});

describe('memoryAdapter drivers', () => {
  it('relations loader groups related rows by join value and honors load scope', async () => {
    const adapter = users();
    seed([{ id: 'u1' }, { id: 'u2' }]);
    seed(
      [
        { id: 'p1', authorId: 'u1', title: 'One' },
        { id: 'p2', authorId: 'u1', title: 'Two', deletedAt: 5 },
        { id: 'p3', authorId: 'u2', title: 'Three' },
      ],
      'posts',
    );
    const rows = [{ id: 'u1' }, { id: 'u2' }];
    const loaded = await adapter.relations!.load(rows, 'posts', {}, scope);
    expect(loaded.get('u1')).toHaveLength(2);

    const scoped = await adapter.relations!.load(
      rows,
      'posts',
      { excludeDeletedField: 'deletedAt' },
      scope,
    );
    expect(scoped.get('u1')).toHaveLength(1);
    expect(scoped.get('u2')).toHaveLength(1);
  });

  it('cascade driver counts, deletes, and nullifies related rows', async () => {
    const adapter = users();
    seed(
      [
        { id: 'p1', authorId: 'u1' },
        { id: 'p2', authorId: 'u1' },
        { id: 'p3', authorId: 'u2' },
      ],
      'posts',
    );
    expect(await adapter.cascade!.countRelated('posts', 'u1', scope)).toBe(2);
    expect(await adapter.cascade!.nullifyRelated('posts', 'u2', scope)).toBe(1);
    expect((getStore('posts').get('p3') as Record<string, unknown>).authorId).toBeNull();
    expect(await adapter.cascade!.deleteRelated('posts', 'u1', scope)).toBe(2);
    expect(getStore('posts').size).toBe(1);
  });

  it('nested driver creates children stamped with the parent foreign key', async () => {
    const adapter = users();
    const parent = { id: 'u1' };
    await adapter.nested!.createNested(parent, 'posts', [{ title: 'Hello' }], scope);
    const posts = Array.from(getStore('posts').values());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ title: 'Hello', authorId: 'u1' });
    expect(typeof posts[0].id).toBe('string');
  });
});
