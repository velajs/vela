import { describe, it, expect } from 'vitest';
import { KVCacheStore } from '../services/kv-cache.store';

function fakeKVService() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const namespace = {
    async get(key: string, type?: 'json') {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return {
        keys: [...store.keys()].map((name) => ({ name })),
        list_complete: true as const,
      };
    },
  };
  // Only `.namespace` is used by KVCacheStore.
  return { service: namespace as unknown as KVNamespace, store, ttls };
}

describe('KVCacheStore', () => {
  it('round-trips JSON values', async () => {
    const { service, store } = fakeKVService();
    const kv = new KVCacheStore(service);
    await kv.set('k', { a: 1 });
    expect(store.get('k')).toBe(JSON.stringify({ a: 1 }));
    expect(await kv.get('k')).toEqual({ a: 1 });
  });

  it('maps a KV miss (null) to undefined', async () => {
    const { service } = fakeKVService();
    const kv = new KVCacheStore(service);
    expect(await kv.get('nope')).toBeUndefined();
  });

  it('clamps sub-minute TTLs up to the 60s KV minimum, leaves larger ones', async () => {
    const { service, ttls } = fakeKVService();
    const kv = new KVCacheStore(service);
    await kv.set('k', 1, 5);
    expect(ttls.get('k')).toBe(60);
    await kv.set('k2', 1, 120);
    expect(ttls.get('k2')).toBe(120);
  });

  it('del removes one entry; clear removes all', async () => {
    const { service, store } = fakeKVService();
    const kv = new KVCacheStore(service);
    await kv.set('a', 1);
    await kv.set('b', 2);
    await kv.del('a');
    expect(store.has('a')).toBe(false);
    await kv.clear();
    expect(store.size).toBe(0);
  });
});
