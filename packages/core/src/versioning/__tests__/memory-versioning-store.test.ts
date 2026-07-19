import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryVersioningStore, type VersionEntry } from '../index';

const keyFor = (recordId: string | number, tenantNamespace = 'global') => ({
  tenantNamespace,
  primaryKey: JSON.stringify([['id', typeof recordId, recordId]]),
});

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
    await store.save('users', keyFor('rec-1'), makeEntry('rec-1', 1, { name: 'Ada' }));

    const all = await store.list('users', keyFor('rec-1'));
    expect(all).toHaveLength(1);
    expect(all[0].data).toEqual({ name: 'Ada' });

    const v1 = await store.get('users', keyFor('rec-1'), 1);
    expect(v1).not.toBeNull();
    expect(v1!.version).toBe(1);

    expect(await store.latest('users', keyFor('rec-1'))).toBe(1);
  });

  it('keeps two tables sharing a recordId fully isolated', async () => {
    await store.save('users', keyFor('42'), makeEntry('42', 1, { kind: 'user-v1' }));
    await store.save('users', keyFor('42'), makeEntry('42', 2, { kind: 'user-v2' }));
    await store.save('orders', keyFor('42'), makeEntry('42', 1, { kind: 'order-v1' }));

    const userVersions = await store.list('users', keyFor('42'));
    expect(userVersions).toHaveLength(2);
    // newest-first ordering
    expect(userVersions.map((v) => v.data)).toEqual([{ kind: 'user-v2' }, { kind: 'user-v1' }]);

    const orderVersions = await store.list('orders', keyFor('42'));
    expect(orderVersions).toHaveLength(1);
    expect(orderVersions[0].data).toEqual({ kind: 'order-v1' });

    expect(await store.get('orders', keyFor('42'), 2)).toBeNull();
    expect(await store.get('users', keyFor('42'), 2)).not.toBeNull();

    expect(await store.latest('users', keyFor('42'))).toBe(2);
    expect(await store.latest('orders', keyFor('42'))).toBe(1);
  });

  it('returns empty / zero for an unknown table+record', async () => {
    await store.save('users', keyFor('rec-1'), makeEntry('rec-1', 1, { name: 'Ada' }));

    expect(await store.list('comments', keyFor('rec-1'))).toEqual([]);
    expect(await store.get('comments', keyFor('rec-1'), 1)).toBeNull();
    expect(await store.latest('comments', keyFor('rec-1'))).toBe(0);
  });

  it('lists newest-first with limit/offset pagination', async () => {
    for (let i = 1; i <= 10; i++) {
      await store.save(
        'documents',
        keyFor('doc-123'),
        makeEntry('doc-123', i, { title: `Version ${i}` }),
      );
    }

    const page1 = await store.list('documents', keyFor('doc-123'), { limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);
    expect(page1[0].version).toBe(10);

    const page2 = await store.list('documents', keyFor('doc-123'), { limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].version).toBe(7);
  });

  it('prunes old versions, keeping the newest', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.save(
        'documents',
        keyFor('doc-123'),
        makeEntry('doc-123', i, { title: `Version ${i}` }),
      );
    }

    const deleted = await store.prune('documents', keyFor('doc-123'), 3);
    expect(deleted).toBe(2);

    const remaining = await store.list('documents', keyFor('doc-123'));
    expect(remaining).toHaveLength(3);
    expect(remaining.map((v) => v.version).sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });

  it('deletes all versions for a record', async () => {
    for (let i = 1; i <= 3; i++) {
      await store.save(
        'documents',
        keyFor('doc-123'),
        makeEntry('doc-123', i, { title: `Version ${i}` }),
      );
    }

    const deleted = await store.deleteAll('documents', keyFor('doc-123'));
    expect(deleted).toBe(3);
    expect(await store.list('documents', keyFor('doc-123'))).toHaveLength(0);
  });

  it('tracks the highest version as `latest`', async () => {
    expect(await store.latest('documents', keyFor('doc-123'))).toBe(0);
    await store.save('documents', keyFor('doc-123'), makeEntry('doc-123', 1, { title: 'V1' }));
    expect(await store.latest('documents', keyFor('doc-123'))).toBe(1);
    await store.save('documents', keyFor('doc-123'), makeEntry('doc-123', 2, { title: 'V2' }));
    expect(await store.latest('documents', keyFor('doc-123'))).toBe(2);
  });

  it('isolates equal primary keys across tenant namespaces', async () => {
    await store.save(
      'documents',
      keyFor('same', 'tenant:a'),
      makeEntry('same', 1, { tenant: 'a' }),
    );
    await store.save(
      'documents',
      keyFor('same', 'tenant:b'),
      makeEntry('same', 1, { tenant: 'b' }),
    );

    expect((await store.list('documents', keyFor('same', 'tenant:a')))[0]?.data).toEqual({
      tenant: 'a',
    });
    expect((await store.list('documents', keyFor('same', 'tenant:b')))[0]?.data).toEqual({
      tenant: 'b',
    });
  });

  it('isolates rows that share the first member of a composite primary key', async () => {
    const usKey = {
      tenantNamespace: 'global',
      primaryKey: JSON.stringify([
        ['id', 'string', 'same'],
        ['region', 'string', 'us'],
      ]),
    };
    const euKey = {
      tenantNamespace: 'global',
      primaryKey: JSON.stringify([
        ['id', 'string', 'same'],
        ['region', 'string', 'eu'],
      ]),
    };
    await store.save('documents', usKey, makeEntry('same', 1, { region: 'us' }));
    await store.save('documents', euKey, makeEntry('same', 1, { region: 'eu' }));

    expect((await store.get('documents', usKey, 1))?.data).toEqual({ region: 'us' });
    expect((await store.get('documents', euKey, 1))?.data).toEqual({ region: 'eu' });
  });
});
