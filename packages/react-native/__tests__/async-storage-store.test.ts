import { describe, expect, it } from 'vitest';
import type { PersistedMutation } from '@velajs/client';
import {
  createAsyncStorageMutationStore,
  DEFAULT_MUTATION_STORE_KEY,
} from '../src/async-storage-store';
import { makeAsyncStorage } from './harness';

const rec = (id: string): PersistedMutation => ({
  id,
  path: '/todos',
  body: { id },
  identity: 'user-a:epoch-1',
});
const ids = (records: PersistedMutation[]): string[] => records.map((record) => record.id);
const ACCOUNT = { account: 'user-a:epoch-1' } as const;
const PARTITION_KEY = `${DEFAULT_MUTATION_STORE_KEY}:user-a%3Aepoch-1`;

describe('createAsyncStorageMutationStore', () => {
  it('round-trips append (FIFO), remove-middle, and clear', async () => {
    const storage = makeAsyncStorage();
    const store = createAsyncStorageMutationStore({ storage });

    await store.append(rec('a'), ACCOUNT);
    await store.append(rec('b'), ACCOUNT);
    await store.append(rec('c'), ACCOUNT);
    expect(ids(await store.load(ACCOUNT))).toEqual(['a', 'b', 'c']);

    await store.remove('b', ACCOUNT);
    expect(ids(await store.load(ACCOUNT))).toEqual(['a', 'c']);

    await store.clear(ACCOUNT);
    expect(await store.load(ACCOUNT)).toEqual([]);
  });

  it('load() decodes invalid JSON to [] without throwing', async () => {
    const storage = makeAsyncStorage({ [PARTITION_KEY]: '{not json' });
    const store = createAsyncStorageMutationStore({ storage });
    await expect(store.load(ACCOUNT)).resolves.toEqual([]);
  });

  it('load() decodes non-array JSON to [] without throwing', async () => {
    const storage = makeAsyncStorage({ [PARTITION_KEY]: '{}' });
    const store = createAsyncStorageMutationStore({ storage });
    await expect(store.load(ACCOUNT)).resolves.toEqual([]);
  });

  it('load() returns a deep copy — mutating it cannot corrupt the store', async () => {
    const storage = makeAsyncStorage();
    const store = createAsyncStorageMutationStore({ storage });
    await store.append(rec('a'), ACCOUNT);

    const first = await store.load(ACCOUNT);
    (first[0] as PersistedMutation).id = 'mutated';
    expect(ids(await store.load(ACCOUNT))).toEqual(['a']);
  });

  it('persists across store instances over the same storage (reload durability)', async () => {
    const storage = makeAsyncStorage();
    const first = createAsyncStorageMutationStore({ storage });
    await first.append(rec('a'), ACCOUNT);
    await first.append(rec('b'), ACCOUNT);

    // A fresh store over the SAME storage seeds its mirror from the durable key.
    const second = createAsyncStorageMutationStore({ storage });
    expect(ids(await second.load(ACCOUNT))).toEqual(['a', 'b']);
  });

  it('serializes un-awaited append/append/remove into a consistent final state', async () => {
    const store = createAsyncStorageMutationStore({ storage: makeAsyncStorage() });

    // Fire the way the offline queue does — without awaiting each op.
    const pending = [
      store.append(rec('x'), ACCOUNT),
      store.append(rec('y'), ACCOUNT),
      store.remove('x', ACCOUNT),
    ];
    await Promise.all(pending);

    expect(ids(await store.load(ACCOUNT))).toEqual(['y']);
  });

  it('honours a custom key', async () => {
    const storage = makeAsyncStorage();
    const store = createAsyncStorageMutationStore({ storage, key: 'custom.key' });
    await store.append(rec('a'), ACCOUNT);

    expect(storage.map.has('custom.key:user-a%3Aepoch-1')).toBe(true);
    expect(storage.map.has(DEFAULT_MUTATION_STORE_KEY)).toBe(false);
  });
});
