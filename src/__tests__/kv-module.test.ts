import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Module, Injectable, MetadataRegistry } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { KVModule } from '../modules/kv.module';
import { KVService } from '../services/kv.service';
beforeEach(() => {
  MetadataRegistry.clear();
});

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    getWithMetadata: async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
    }),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
    }),
    _store: store,
  };
}

describe('KVModule', () => {
  it('should inject KVService with working get/put/delete', async () => {
    const mockKV = createMockKV();

    @Controller('/cache')
    class CacheController {
      constructor(private kv: KVService) {}

      @Get('/set')
      async set() {
        await this.kv.namespace.put('greeting', 'hello');
        return { ok: true };
      }

      @Get('/get')
      async getVal() {
        const val = await this.kv.namespace.get('greeting');
        return { value: val };
      }

      @Get('/del')
      async del() {
        await this.kv.namespace.delete('greeting');
        return { ok: true };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'CACHE' })],
      controllers: [CacheController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    // First request initializes bindings via middleware
    const setRes = await hono.request('/cache/set', undefined, { CACHE: mockKV });
    expect(setRes.status).toBe(200);

    const getRes = await hono.request('/cache/get', undefined, { CACHE: mockKV });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ value: 'hello' });

    const delRes = await hono.request('/cache/del', undefined, { CACHE: mockKV });
    expect(delRes.status).toBe(200);

    const getRes2 = await hono.request('/cache/get', undefined, { CACHE: mockKV });
    expect(await getRes2.json()).toEqual({ value: null });
  });

  it('should support list operation', async () => {
    const mockKV = createMockKV();
    mockKV._store.set('a', '1');
    mockKV._store.set('b', '2');

    @Controller('/kv')
    class KVController {
      constructor(private kv: KVService) {}

      @Get('/list')
      async listKeys() {
        const result = await this.kv.namespace.list();
        return result;
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'MY_KV' })],
      controllers: [KVController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/kv/list', undefined, { MY_KV: mockKV });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { keys: { name: string }[] };
    expect(data.keys.length).toBe(2);
  });

  it('should allow KVService in nested providers', async () => {
    const mockKV = createMockKV();

    @Injectable()
    class UserCache {
      constructor(private kv: KVService) {}
      async getUser(id: string) {
        return this.kv.namespace.get(`user:${id}`);
      }
      async setUser(id: string, data: string) {
        return this.kv.namespace.put(`user:${id}`, data);
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private cache: UserCache) {}

      @Get('/cache-test')
      async test() {
        await this.cache.setUser('1', JSON.stringify({ name: 'Alice' }));
        const result = await this.cache.getUser('1');
        return { user: result ? JSON.parse(result as string) : null };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'USERS_KV' })],
      providers: [UserCache],
      controllers: [UserController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/users/cache-test', undefined, { USERS_KV: mockKV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { name: 'Alice' } });
  });

  it('should expose raw namespace via .namespace getter', async () => {
    const mockKV = createMockKV();

    @Controller('/raw')
    class RawController {
      constructor(private kv: KVService) {}

      @Get()
      async test() {
        const ns = this.kv.namespace;
        await ns.put('raw', 'test');
        const val = await ns.get('raw');
        return { value: val };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'NS' })],
      controllers: [RawController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/raw', undefined, { NS: mockKV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'test' });
  });
});
