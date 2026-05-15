import { describe, it, expect, beforeEach } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import { Controller, Get, Module, MetadataRegistry } from '@velajs/vela';
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
});
