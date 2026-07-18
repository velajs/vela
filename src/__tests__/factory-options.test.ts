import { describe, it, expect, beforeEach } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import {
  Controller,
  Get,
  Ip,
  Module,
  MetadataRegistry,
  ThrottlerModule,
  VelaFactory,
} from '@velajs/vela';
import { cloudflareAdapter, createCloudflareApp } from '../cloudflare-factory';
import { KVModule } from '../modules/kv.module';
import { KVService } from '../services/kv.service';

beforeEach(() => {
  MetadataRegistry.clear();
});

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null }),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
    _store: store,
  };
}

describe('createCloudflareApp options', () => {
  it('forwards globalPrefix to VelaFactory.create', async () => {
    @Controller('/users')
    class UserController {
      @Get()
      list() {
        return { users: ['alice', 'bob'] };
      }
    }

    @Module({ controllers: [UserController] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { globalPrefix: '/api' });
    const hono = app.getHonoApp();

    // With globalPrefix '/api', the controller path '/users' is mounted at '/api/users'.
    const prefixed = await hono.request('/api/users', undefined, {});
    expect(prefixed.status).toBe(200);
    expect(await prefixed.json()).toEqual({ users: ['alice', 'bob'] });

    // The unprefixed path must NOT resolve when a global prefix is set.
    const unprefixed = await hono.request('/users', undefined, {});
    expect(unprefixed.status).toBe(404);
  });

  it('runs caller-supplied middleware on every request', async () => {
    type Vars = { marker?: string };

    const markerMw: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
      c.set('marker', 'ran');
      await next();
    };

    @Controller('/marker')
    class MarkerController {
      @Get()
      read() {
        return { ok: true };
      }
    }

    @Module({ controllers: [MarkerController] })
    class AppModule {}

    let observedMarker: unknown;
    const observerMw: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
      observedMarker = c.get('marker');
      await next();
    };

    const app = await createCloudflareApp(AppModule, {
      middleware: [markerMw, observerMw],
    });
    const hono = app.getHonoApp();

    const res = await hono.request('/marker', undefined, {});
    expect(res.status).toBe(200);
    expect(observedMarker).toBe('ran');
  });

  it('runs the binding-init middleware BEFORE user-supplied middleware', async () => {
    const mockKV = createMockKV();

    // The user middleware closes over `kvServiceHolder`, which we populate
    // after factory construction with the resolved KVService. From inside
    // user middleware we then access `kv.namespace` — this goes through
    // `BindingRef.value`, which throws if the binding-init middleware
    // hasn't run yet. Successful access proves binding-init ran first.
    const kvServiceHolder: { kv?: KVService } = {};
    let observedNamespace: unknown;
    let observationError: unknown;

    @Controller('/_observe')
    class ObserveController {
      @Get()
      ok() {
        return { ok: true };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'CACHE' })],
      controllers: [ObserveController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, {
      middleware: [
        async (_c, next) => {
          try {
            // If user middleware ran BEFORE binding-init, reading
            // `.namespace` would throw "binding not initialized".
            observedNamespace = kvServiceHolder.kv!.namespace;
          } catch (err) {
            observationError = err;
          }
          await next();
        },
      ],
    });

    // Pull the KVService out of the instances collected during factory
    // construction. Touching `.namespace` here (before any request) would
    // throw, but capturing the service reference is safe — the BindingRef
    // is lazy.
    const instances = (
      app as unknown as { app: { getInstances: () => unknown[] } }
    ).app.getInstances();
    const kv = instances.find((i): i is KVService => i instanceof KVService);
    if (!kv) throw new Error('KVService not found in instances');
    kvServiceHolder.kv = kv;

    const hono = app.getHonoApp();
    const res = await hono.request('/_observe', undefined, { CACHE: mockKV });

    expect(res.status).toBe(200);
    expect(observationError).toBeUndefined();
    // Binding-init populated the BindingRef before user middleware ran.
    expect(observedNamespace).toBe(mockKV);
  });

  it('preserves backwards-compatible single-arg signature', async () => {
    @Controller('/ping')
    class PingController {
      @Get()
      ping() {
        return { pong: true };
      }
    }

    @Module({ controllers: [PingController] })
    class AppModule {}

    // No options arg — must still work exactly as before.
    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/ping', undefined, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it('uses only Cloudflare-attested client IP and ignores spoofed forwarding headers', async () => {
    @Controller('/ip')
    class IpController {
      @Get()
      read(@Ip() ip: string | null) {
        return { ip };
      }
    }

    @Module({ controllers: [IpController] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();
    const trusted = await hono.request(
      '/ip',
      {
        headers: {
          'cf-connecting-ip': '203.0.113.9',
          'x-forwarded-for': 'attacker',
          'x-real-ip': 'attacker-too',
        },
      },
      {},
    );
    expect(await trusted.json()).toEqual({ ip: '203.0.113.9' });

    const spoofOnly = await hono.request(
      '/ip',
      { headers: { 'x-forwarded-for': '198.51.100.1' } },
      {},
    );
    expect(await spoofOnly.json()).toEqual({ ip: null });
  });

  it('uses the same trusted Cloudflare identity for default throttling', async () => {
    @Controller('/limited')
    class LimitedController {
      @Get()
      get() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ limit: 1, ttl: 60_000 })],
      controllers: [LimitedController],
    })
    class AppModule {}

    const hono = (await createCloudflareApp(AppModule)).getHonoApp();
    const first = await hono.request(
      '/limited',
      { headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': 'a' } },
      {},
    );
    const spoofChanged = await hono.request(
      '/limited',
      { headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': 'b' } },
      {},
    );
    const otherClient = await hono.request(
      '/limited',
      { headers: { 'cf-connecting-ip': '203.0.113.2', 'x-forwarded-for': 'a' } },
      {},
    );
    expect(first.status).toBe(200);
    expect(spoofChanged.status).toBe(429);
    expect(otherClient.status).toBe(200);
  });

  it('applies the adapter trust resolver for direct VelaFactory composition', async () => {
    @Controller('/direct-ip')
    class IpController {
      @Get()
      read(@Ip() ip: string | null) {
        return { ip };
      }
    }
    @Module({ controllers: [IpController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { adapters: [cloudflareAdapter()] });
    const response = await app.getHonoApp().request('/direct-ip', {
      headers: { 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': 'spoofed' },
    });
    expect(await response.json()).toEqual({ ip: '192.0.2.10' });
  });

  it('forwards unified parser security options', async () => {
    @Controller('/bounded')
    class BoundedController {
      @Get()
      get() {
        return { ok: true };
      }
    }
    @Module({ controllers: [BoundedController] })
    class AppModule {}

    const hono = (
      await createCloudflareApp(AppModule, {
        security: { query: { maxParameters: 1 } },
      })
    ).getHonoApp();
    const response = await hono.request('/bounded?a=1&b=2', undefined, {});
    expect(response.status).toBe(400);
  });
});
