import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineModel, defineResource } from '@velajs/crud';
import { MemoryStore, memoryAdapter, transactionalMemoryAdapter } from '@velajs/crud-memory';

const schema = z.object({ id: z.string(), label: z.string(), secret: z.string().optional() });
const model = () => defineModel({ name: 'item', tableName: 'items', schema, timestamps: false });

it.each([undefined, []])(
  'denies undeclared includes on both read and list (%j)',
  async (allowedIncludes) => {
    const store = new MemoryStore();
    store.table('items').set('p', { id: 'p', label: 'parent' });
    store
      .table('children')
      .set('c', { id: 'c', parentId: 'p', tenantId: 'foreign', secret: 'hidden' });
    const resource = defineResource('items', {
      model: defineModel({
        name: 'parent',
        tableName: 'items',
        schema,
        timestamps: false,
        relations: { children: { type: 'hasMany', target: 'children', foreignKey: 'parentId' } },
      }),
      allowedIncludes,
      adapter: memoryAdapter({
        store,
        tableName: 'items',
        relations: { children: { type: 'hasMany', table: 'children', foreignKey: 'parentId' } },
      }),
    });
    const read = await resource.execute('read', { id: 'p', query: { include: 'children' } });
    expect(read.body).toMatchObject({ result: { id: 'p' } });
    expect(JSON.stringify(read.body)).not.toContain('children');
    const list = await resource.execute('list', { query: { include: 'children' } });
    expect(JSON.stringify(list.body)).not.toContain('children');
    expect(JSON.stringify(list.body)).not.toContain('hidden');
  },
);

it.each([
  { 'label[typo]': 'target' },
  { unknown: 'target' },
  { 'label[ne]': 'target' },
  { search: 'target' },
  { include: 'children' },
  { page: '1' },
  { label: ['target'] },
  { label: null },
  { 'label[between]': 'one' },
  { 'label[between]': 'one,two,three' },
  { 'label[null]': 'typo' },
  [],
  null,
])('rejects malformed bulk filters before writing (%j)', async (filter) => {
  const store = new MemoryStore();
  store.table('items').set('a', { id: 'a', label: 'keep' });
  store.table('items').set('b', { id: 'b', label: 'also-keep' });
  const resource = defineResource('items', {
    model: model(),
    filterConfig: { label: ['eq', 'between', 'null'] },
    adapter: memoryAdapter({ store, tableName: 'items' }),
  });
  await expect(
    resource.execute('bulkPatch', { body: { filter, data: { label: 'changed' } } }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect([...store.table('items').values()].map((row) => row.label)).toEqual(['keep', 'also-keep']);
});

it('accepts valid bulk filters and updates only matching rows', async () => {
  const store = new MemoryStore();
  store.table('items').set('a', { id: 'a', label: 'target' });
  store.table('items').set('b', { id: 'b', label: 'keep' });
  const resource = defineResource('items', {
    model: model(),
    filterConfig: { label: ['eq', 'between', 'null'] },
    adapter: memoryAdapter({ store, tableName: 'items' }),
  });
  await resource.execute('bulkPatch', {
    body: { filter: { label: 'target' }, data: { label: 'changed' } },
  });
  expect([...store.table('items').values()].map((row) => row.label)).toEqual(['changed', 'keep']);
});

describe('read lifecycle', () => {
  it('runs hooks around the lookup, masks their output, and keeps storage and ETags intact', async () => {
    const store = new MemoryStore();
    store.table('items').set('a', { id: 'a', label: 'stored', secret: 'private' });
    const adapter = transactionalMemoryAdapter({ store, tableName: 'items' });
    const events: string[] = [];
    const lookup = adapter.runtime.readOne;
    adapter.runtime.readOne = async (...args) => {
      events.push('read');
      return lookup(...args);
    };
    const configuredModel = defineModel({
      name: 'item',
      tableName: 'items',
      schema,
      timestamps: false,
      serializationProfile: { exclude: ['secret'] },
    });
    const plain = defineResource('plain', { model: configuredModel, adapter, etag: true });
    const original = await plain.execute('read', { id: 'a' });
    events.length = 0;
    const resource = defineResource('items', {
      model: configuredModel,
      adapter,
      etag: true,
      hooks: {
        beforeRead(_ctx, id) {
          events.push(`before:${id}`);
        },
        afterRead(_ctx, row) {
          events.push('after');
          row.label = 'display';
          row.secret = 'new-secret';
          return row;
        },
      },
    });
    const result = await resource.execute('read', { id: 'a' });
    expect(events).toEqual(['before:a', 'read', 'after']);
    expect(result.body).toMatchObject({ result: { label: 'display' } });
    expect(JSON.stringify(result.body)).not.toContain('secret');
    expect(store.table('items').get('a')).toEqual({ id: 'a', label: 'stored', secret: 'private' });
    expect(result.headers?.ETag).toBe(original.headers?.ETag);
    expect(
      (
        await resource.execute('update', {
          id: 'a',
          body: { label: 'updated' },
          request: new Request('http://test/', { headers: { 'If-Match': result.headers!.ETag! } }),
        })
      ).status,
    ).toBe(200);
  });

  it('detaches hook input even when an adapter returns its stored object', async () => {
    const store = new MemoryStore();
    store.table('items').set('a', { id: 'a', label: 'stored' });
    const resource = defineResource('items', {
      model: model(),
      adapter: memoryAdapter({ store, tableName: 'items' }),
      hooks: {
        afterRead(_ctx, row) {
          row.label = 'display';
          return row;
        },
      },
    });
    expect((await resource.execute('read', { id: 'a' })).body).toMatchObject({
      result: { label: 'display' },
    });
    expect(store.table('items').get('a')?.label).toBe('stored');
  });

  it('stops lookup and afterRead when beforeRead fails', async () => {
    const adapter = memoryAdapter({ tableName: 'items' });
    const lookup = vi.spyOn(adapter.runtime, 'readOne');
    const afterRead = vi.fn();
    const resource = defineResource('items', {
      model: model(),
      adapter,
      hooks: {
        beforeRead() {
          throw new Error('read stopped');
        },
        afterRead,
      },
    });
    await expect(resource.execute('read', { id: 'a' })).rejects.toThrow('read stopped');
    expect(lookup).not.toHaveBeenCalled();
    expect(afterRead).not.toHaveBeenCalled();
  });

  it('does not call afterRead for missing or unauthorized rows', async () => {
    const store = new MemoryStore();
    store.table('items').set('a', { id: 'a', label: 'hidden' });
    const afterRead = vi.fn();
    const resource = defineResource('items', {
      model: defineModel({
        name: 'item',
        tableName: 'items',
        schema,
        timestamps: false,
        policies: { read: () => false },
      }),
      adapter: memoryAdapter({ store, tableName: 'items' }),
      hooks: { afterRead },
    });
    for (const id of ['a', 'absent']) {
      await expect(resource.execute('read', { id })).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(afterRead).not.toHaveBeenCalled();
  });
});

it.each(['restrict', 'cascade', 'setNull'])(
  'rejects obsolete cascade configuration (%s)',
  (action) => {
    expect(() =>
      defineModel({
        name: 'item',
        tableName: 'items',
        schema,
        timestamps: false,
        relations: {
          children: { type: 'hasMany', foreignKey: 'parentId', cascade: { onDelete: action } },
        },
      }),
    ).toThrow('Use database foreign keys');
  },
);

it('rejects ETags on adapters without transactional row locking', () => {
  expect(() =>
    defineResource('items', {
      model: model(),
      etag: true,
      adapter: memoryAdapter({ tableName: 'items' }),
    }),
  ).toThrow('rowLocks');
});
