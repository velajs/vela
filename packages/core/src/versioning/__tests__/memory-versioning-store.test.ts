import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryVersioningStore, type VersionEntry } from '../index';

/**
 * MemoryVersioningStore — the plain-Map reference implementation of the
 * `VersioningStore` seam. Parity with hono-crud 0.13
 * `MemoryVersioningStorage` (methods renamed store→save, getByRecordId→list,
 * getVersion→get, getLatestVersion→latest): per-(tableName, recordId) keying,
 * newest-first ordering, `latest` = max stored version or 0.
 */

function makeEntry(
  recordId: string | number,
  version: number,
  data: Record<string, unknown>,
): VersionEntry {
  return { id: crypto.randomUUID(), recordId, version, data, createdAt: new Date() };
}

describe('MemoryVersioningStore', () => {
  let store: MemoryVersioningStore;

  beforeEach(() => {
    store = new MemoryVersioningStore();
  });

  it('round-trips a stored entry via list / get / latest', async () => {
    await store.save('users', makeEntry('rec-1', 1, { name: 'Ada' }));

    const all = await store.list('users', 'rec-1');
    expect(all).toHaveLength(1);
    expect(all[0].data).toEqual({ name: 'Ada' });

    const v1 = await store.get('users', 'rec-1', 1);
    expect(v1).not.toBeNull();
    expect(v1!.version).toBe(1);

    expect(await store.latest('users', 'rec-1')).toBe(1);
  });

  it('keeps two tables sharing a recordId fully isolated', async () => {
    await store.save('users', makeEntry('42', 1, { kind: 'user-v1' }));
    await store.save('users', makeEntry('42', 2, { kind: 'user-v2' }));
    await store.save('orders', makeEntry('42', 1, { kind: 'order-v1' }));

    const userVersions = await store.list('users', '42');
    expect(userVersions).toHaveLength(2);
    // newest-first ordering
    expect(userVersions.map((v) => v.data)).toEqual([{ kind: 'user-v2' }, { kind: 'user-v1' }]);

    const orderVersions = await store.list('orders', '42');
    expect(orderVersions).toHaveLength(1);
    expect(orderVersions[0].data).toEqual({ kind: 'order-v1' });

    expect(await store.get('orders', '42', 2)).toBeNull();
    expect(await store.get('users', '42', 2)).not.toBeNull();

    expect(await store.latest('users', '42')).toBe(2);
    expect(await store.latest('orders', '42')).toBe(1);
  });

  it('returns empty / zero for an unknown table+record', async () => {
    await store.save('users', makeEntry('rec-1', 1, { name: 'Ada' }));

    expect(await store.list('comments', 'rec-1')).toEqual([]);
    expect(await store.get('comments', 'rec-1', 1)).toBeNull();
    expect(await store.latest('comments', 'rec-1')).toBe(0);
  });

  it('lists newest-first with limit/offset pagination', async () => {
    for (let i = 1; i <= 10; i++) {
      await store.save('documents', makeEntry('doc-123', i, { title: `Version ${i}` }));
    }

    const page1 = await store.list('documents', 'doc-123', { limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);
    expect(page1[0].version).toBe(10);

    const page2 = await store.list('documents', 'doc-123', { limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].version).toBe(7);
  });

  it('prunes old versions, keeping the newest', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.save('documents', makeEntry('doc-123', i, { title: `Version ${i}` }));
    }

    const deleted = await store.prune('documents', 'doc-123', 3);
    expect(deleted).toBe(2);

    const remaining = await store.list('documents', 'doc-123');
    expect(remaining).toHaveLength(3);
    expect(remaining.map((v) => v.version).sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });

  it('deletes all versions for a record', async () => {
    for (let i = 1; i <= 3; i++) {
      await store.save('documents', makeEntry('doc-123', i, { title: `Version ${i}` }));
    }

    const deleted = await store.deleteAll('documents', 'doc-123');
    expect(deleted).toBe(3);
    expect(await store.list('documents', 'doc-123')).toHaveLength(0);
  });

  it('tracks the highest version as `latest`', async () => {
    expect(await store.latest('documents', 'doc-123')).toBe(0);
    await store.save('documents', makeEntry('doc-123', 1, { title: 'V1' }));
    expect(await store.latest('documents', 'doc-123')).toBe(1);
    await store.save('documents', makeEntry('doc-123', 2, { title: 'V2' }));
    expect(await store.latest('documents', 'doc-123')).toBe(2);
  });
});
