import { describe, expect, it } from 'vitest';
import type { PersistedMutation } from '@velajs/client';
import {
  createAsyncStorageMutationStore,
  DEFAULT_MUTATION_STORE_KEY,
} from '../src/async-storage-store';
import { makeAsyncStorage } from './harness';

const rec = (id: string): PersistedMutation => ({ id, path: '/todos', body: { id } });
const ids = (records: PersistedMutation[]): string[] => records.map((record) => record.id);

describe('createAsyncStorageMutationStore', () => {
  it('round-trips append (FIFO), remove-middle, and clear', async () => {
    const storage = makeAsyncStorage();
    const store = createAsyncStorageMutationStore({ storage });

    await store.append(rec('a'));
    await store.append(rec('b'));
    await store.append(rec('c'));
    expect(ids(await store.load())).toEqual(['a', 'b', 'c']);

    await store.remove('b');
    expect(ids(await store.load())).toEqual(['a', 'c']);

    await store.clear();
    expect(await store.load()).toEqual([]);
  });

  it('load() decodes invalid JSON to [] without throwing', async () => {
    const storage = makeAsyncStorage({ [DEFAULT_MUTATION_STORE_KEY]: '{not json' });
    const store = createAsyncStorageMutationStore({ storage });
    await expect(store.load()).resolves.toEqual([]);
  });

  it('load() decodes non-array JSON to [] without throwing', async () => {
    const storage = makeAsyncStorage({ [DEFAULT_MUTATION_STORE_KEY]: '{}' });
    const store = createAsyncStorageMutationStore({ storage });
    await expect(store.load()).resolves.toEqual([]);
  });

  it('load() returns a deep copy — mutating it cannot corrupt the store', async () => {
    const storage = makeAsyncStorage();
    const store = createAsyncStorageMutationStore({ storage });
    await store.append(rec('a'));

    const first = await store.load();
    (first[0] as PersistedMutation).id = 'mutated';
    expect(ids(await store.load())).toEqual(['a']);
  });

  it('persists across store instances over the same storage (reload durability)', async () => {
    const storage = makeAsyncStorage();
    const first = createAsyncStorageMutationStore({ storage });
    await first.append(rec('a'));
    await first.append(rec('b'));

    // A fresh store over the SAME storage seeds its mirror from the durable key.
    const second = createAsyncStorageMutationStore({ storage });
    expect(ids(await second.load())).toEqual(['a', 'b']);
  });

  it('serializes un-awaited append/append/remove into a consistent final state', async () => {
    const store = createAsyncStorageMutationStore({ storage: makeAsyncStorage() });

    // Fire the way the offline queue does — without awaiting each op.
    const pending = [store.append(rec('x')), store.append(rec('y')), store.remove('x')];
    await Promise.all(pending);

    expect(ids(await store.load())).toEqual(['y']);
  });

  it('honours a custom key', async () => {
    const storage = makeAsyncStorage();
    const store = createAsyncStorageMutationStore({ storage, key: 'custom.key' });
    await store.append(rec('a'));

    expect(storage.map.has('custom.key')).toBe(true);
    expect(storage.map.has(DEFAULT_MUTATION_STORE_KEY)).toBe(false);
  });
});
