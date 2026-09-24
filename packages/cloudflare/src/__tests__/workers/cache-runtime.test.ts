// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Controller, Get, Module } from '@velajs/vela';
import {
  CacheModule,
  CacheResponse,
  MemoryCacheInvalidationStore,
  MemoryCacheStore,
  TieredCacheStore,
} from '@velajs/vela/cache';
import { createCloudflareWorker } from '../../cloudflare-factory';
import {
  KVCacheStore,
  KVCacheInvalidationStore,
  kvCache,
  kvCacheInvalidation,
} from '../../services/kv-cache.store';

describe('response caching under workerd', () => {
  it('uses native KV metadata for logical expiry and tier backfill in a store built from ENV', async () => {
    let calls = 0;
    const l1 = new MemoryCacheStore();
    @Controller('/cached')
    class ReadController {
      @Get() @CacheResponse({ tags: ['counts'] }) read() {
        return { count: ++calls };
      }
    }
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: `worker-cache-${crypto.randomUUID()}`,
          store: (bindings) => new TieredCacheStore([l1, new KVCacheStore(bindings.CACHE)]),
          invalidation: new MemoryCacheInvalidationStore(),
          scope: () => ({ visibility: 'public' as const, partition: 'counts' }),
          ttl: 10,
        }),
      ],
      controllers: [ReadController],
    })
    class App {}
    const worker = createCloudflareWorker(App);
    const request = () =>
      worker.fetch(new Request('https://worker.test/cached'), env, {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      });
    expect(await (await request()).json()).toEqual({ count: 1 });
    l1.clear();
    expect(await (await request()).json()).toEqual({ count: 1 });
    expect(calls).toBe(1);
  });

  it('serves a static CacheModule from kvCache({ binding }) and kvCacheInvalidation({ binding })', async () => {
    let calls = 0;
    const partition = crypto.randomUUID();
    @Controller('/named')
    class NamedController {
      @Get() @CacheResponse({ tags: ['named'] }) read() {
        return { count: ++calls };
      }
    }
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: 'worker-named',
          store: kvCache({ binding: 'CACHE' }),
          invalidation: kvCacheInvalidation({ binding: 'CACHE' }),
          scope: () => ({ visibility: 'public', partition }),
        }),
      ],
      controllers: [NamedController],
    })
    class App {}
    const worker = createCloudflareWorker(App);
    const request = () =>
      worker.fetch(new Request('https://worker.test/named'), env, {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      });
    expect(await (await request()).json()).toEqual({ count: 1 });
    expect(await (await request()).json()).toEqual({ count: 1 });
    expect(calls).toBe(1);
  });

  it('stores durable generation markers without coupling to value TTLs', async () => {
    const versions = new KVCacheInvalidationStore(env.CACHE);
    const key = `generation-${crypto.randomUUID()}`;
    expect(await versions.getVersion(key)).toBe('initial');
    await versions.invalidate(key);
    // Inspect persistence/shape, not a global read-after-write guarantee.
    const { value, metadata } = await env.CACHE.getWithMetadata(key, 'json');
    expect(typeof value).toBe('string');
    expect(metadata).toBeNull();
  });
});
