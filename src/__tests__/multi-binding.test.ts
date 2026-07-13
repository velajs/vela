import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Module, MetadataRegistry } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { KVModule } from '../modules/kv.module';
import { KVService } from '../services/kv.service';

beforeEach(() => {
  MetadataRegistry.clear();
});

function mockKV(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
  };
}

@Controller('cache')
class CacheController {
  constructor(private readonly kv: KVService) {}
  @Get('/get')
  async get(): Promise<{ v: unknown }> {
    return { v: await this.kv.namespace.get('k') };
  }
}

@Module({ imports: [KVModule.forRoot({ binding: 'CACHE_KV' })], controllers: [CacheController] })
class CacheFeature {}

@Controller('sessions')
class SessionsController {
  constructor(private readonly kv: KVService) {}
  @Get('/get')
  async get(): Promise<{ v: unknown }> {
    return { v: await this.kv.namespace.get('k') };
  }
}

@Module({
  imports: [KVModule.forRoot({ binding: 'SESSIONS_KV' })],
  controllers: [SessionsController],
})
class SessionsFeature {}

@Module({ imports: [CacheFeature, SessionsFeature] })
class AppModule {}

describe('multiple same-type Cloudflare bindings', () => {
  it('initializes every BindingRef, not just the first', async () => {
    const env = {
      CACHE_KV: mockKV({ k: 'from-cache' }),
      SESSIONS_KV: mockKV({ k: 'from-sessions' }),
    };
    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const a = await hono.request('/cache/get', undefined, env);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ v: 'from-cache' });

    // Before the collectBindingRefs fix, the second binding's ref was never
    // initialized and this returned 500 ("binding not initialized").
    const b = await hono.request('/sessions/get', undefined, env);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ v: 'from-sessions' });
  });
});
