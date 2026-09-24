import { afterEach, describe, it, expect, vi } from 'vitest';
import { Controller, Get, Module } from '@velajs/vela';
import { CacheModule, CacheResponse, CacheService } from '@velajs/vela/cache';
import { createCloudflareApp, kvCache, kvCacheInvalidation } from '../index';
import { KVCacheStore, KVCacheInvalidationStore } from '../services/kv-cache.store';

function fakeKVService() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const metadata = new Map<string, unknown>();
  const namespace = {
    async getWithMetadata(key: string) {
      const raw = store.get(key);
      return {
        value: raw === undefined ? null : JSON.parse(raw),
        metadata: metadata.get(key) ?? null,
      };
    },
    async get(key: string, type?: 'json') {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number; metadata?: unknown },
    ) {
      store.set(key, value);
      metadata.set(key, options?.metadata);
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

afterEach(() => vi.useRealTimers());

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

describe('KV cache expiry and invalidation', () => {
  it('honors sub-minute logical TTL even while KV physically retains the value', async () => {
    vi.useFakeTimers();
    const { service, store } = fakeKVService();
    const kv = new KVCacheStore(service);
    await kv.set('key', 1, 1);
    expect(await kv.getEntry('key')).toEqual({ value: 1, expiresAt: Date.now() + 1000 });
    vi.advanceTimersByTime(1000);
    expect(store.has('key')).toBe(true);
    expect(await kv.get('key')).toBeUndefined();
    await kv.set('zero', 1, 0);
    expect(await kv.get('zero')).toBeUndefined();
    await expect(kv.set('invalid', 1, NaN)).rejects.toThrow('TTL');
  });

  it('retains unknown expiry for legacy values and publishes fresh persistent generations', async () => {
    const { service, store, ttls } = fakeKVService();
    store.set('legacy', JSON.stringify({ count: 1 }));
    expect(await new KVCacheStore(service).getEntry('legacy')).toEqual({ value: { count: 1 } });
    const versions = new KVCacheInvalidationStore(service);
    expect(await versions.getVersion('scope')).toBe('initial');
    await versions.invalidate('scope');
    const first = await versions.getVersion('scope');
    await versions.invalidate('scope');
    expect(await versions.getVersion('scope')).not.toBe(first);
    expect(ttls.get('scope')).toBeUndefined();
    store.set('invalid', '42');
    await expect(versions.getVersion('invalid')).rejects.toThrow('generation');
  });
});

describe('kvCache({ binding }) and kvCacheInvalidation({ binding })', () => {
  const scope = () => ({ visibility: 'public', partition: 'kv' }) as const;
  @Controller('/kv')
  class Counter {
    calls = 0;
    @Get() @CacheResponse({ tags: ['count'] }) read() {
      return { calls: ++this.calls };
    }
  }
  @Module({
    imports: [
      CacheModule.forRoot({
        namespace: 'kv',
        scope,
        store: kvCache({ binding: 'CACHE' }),
        invalidation: kvCacheInvalidation({ binding: 'GENERATIONS' }),
      }),
    ],
    controllers: [Counter],
  })
  class App {}

  it('back one static CacheModule with the KV namespaces of each application ENV', async () => {
    const a = { values: fakeKVService(), generations: fakeKVService() };
    const b = { values: fakeKVService(), generations: fakeKVService() };
    const envA = { CACHE: a.values.service, GENERATIONS: a.generations.service };
    const envB = { CACHE: b.values.service, GENERATIONS: b.generations.service };
    const first = await createCloudflareApp(App, { env: envA });
    const second = await createCloudflareApp(App, { env: envB });
    const read = async () =>
      (await first.fetch(new Request('https://app.test/kv'), envA)).json();
    expect(await read()).toEqual({ calls: 1 });
    expect(await read()).toEqual({ calls: 1 });
    expect(a.values.store.size).toBe(1);
    expect(b.values.store.size).toBe(0);
    const result = await first
      .get(CacheService)
      .scope({ visibility: 'public', partition: 'kv' })
      .invalidateTags(['count']);
    expect(result).toEqual({ ok: true });
    expect(a.generations.store.size).toBeGreaterThan(0);
    expect(b.generations.store.size).toBe(0);
    await Promise.all([first.close(), second.close()]);
  });

  it('read no namespace while the application boots, and name kv_namespaces on first use', async () => {
    const app = await createCloudflareApp(App, { env: {} });
    const errors: unknown[] = [];
    const service = app.get(CacheService);
    await service.options.store.get('any').catch((error: unknown) => errors.push(error));
    expect(String(errors[0])).toContain(
      "ENV.CACHE is not set: declare the KV namespace binding 'CACHE' under kv_namespaces",
    );
    await app.close();
  });
});
