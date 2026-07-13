import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Module, MetadataRegistry } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { KVModule } from '../modules/kv.module';
import { KVService } from '../services/kv.service';
import { BindingRef } from '../binding-ref';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('edge cases', () => {
  it('BindingRef throws when accessed before initialization', () => {
    const ref = new BindingRef('TEST');
    expect(() => ref.value).toThrow(/not initialized/);
  });

  it('BindingRef throws when binding name is wrong (initialized with undefined)', () => {
    const ref = new BindingRef('WRONG_NAME');
    ref._initialize(undefined);
    // Still throws because the initialized value IS undefined
    expect(() => ref.value).toThrow(/not initialized/);
  });

  it('should throw clear error when service used without binding in env', async () => {
    @Controller('/test')
    class TestController {
      constructor(private kv: KVService) {}

      @Get()
      async handle() {
        // Binding 'MISSING_KV' won't exist in env
        const val = await this.kv.namespace.get('key');
        return { val };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'MISSING_KV' })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    // Request with env that doesn't have MISSING_KV
    const res = await hono.request('/test', undefined, { OTHER: 'value' });
    // The service should throw when accessing the binding
    expect(res.status).toBe(500);
  });

  it('should work with controllers that have no module-service dependencies', async () => {
    @Controller('/plain')
    class PlainController {
      @Get()
      handle() {
        return { simple: true };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'KV' })],
      controllers: [PlainController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const mockKV = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [] }),
      getWithMetadata: async () => ({ value: null }),
    };
    const res = await hono.request('/plain', undefined, { KV: mockKV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ simple: true });
  });

  it('should handle second request without re-initializing bindings', async () => {
    const mockKV = {
      get: async (key: string) => `value-for-${key}`,
      getWithMetadata: async () => ({ value: null }),
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [] }),
    };

    @Controller('/test')
    class TestController {
      constructor(private kv: KVService) {}

      @Get()
      async handle() {
        const val = await this.kv.namespace.get('key');
        return { val };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'KV' })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    // First request initializes
    const res1 = await hono.request('/test', undefined, { KV: mockKV });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ val: 'value-for-key' });

    // Second request works without env (bindings already initialized)
    const res2 = await hono.request('/test');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ val: 'value-for-key' });
  });
});
