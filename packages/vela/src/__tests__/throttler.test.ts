import { defineProvider } from '../container/types';
import { describe, it, expect } from 'vitest';
import {
  APP_GUARD,
  VelaFactory,
  Controller,
  Ctx,
  Get,
  Injectable,
  Module,
  REQUEST_CONTEXT,
} from '../index.js';
import { getRequestContainer, setTrustedRequestIdentity } from '../module-kit.js';
import { RATE_LIMIT, ThrottlerModule, Throttle, SkipThrottle } from '../throttler/index.js';
import type { CanActivate, ExecutionContext, Type, VelaContext, VelaEnv } from '../index.js';
import type {
  RateLimitInfo,
  ThrottlerOptions,
  ThrottlerStore,
  ThrottlerStorageRecord,
} from '../throttler/index.js';

describe('ThrottlerModule', () => {
  it('should allow requests under the limit', async () => {
    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 5, ttl: 60000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    for (let i = 0; i < 5; i++) {
      const res = await hono.request('/test/data');
      expect(res.status).toBe(200);
    }
  });

  it('should block requests exceeding the limit (429)', async () => {
    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 3, ttl: 60000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    for (let i = 0; i < 3; i++) {
      const res = await hono.request('/test/data');
      expect(res.status).toBe(200);
    }

    const blocked = await hono.request('/test/data');
    expect(blocked.status).toBe(429);
  });

  it('should set rate-limit response headers', async () => {
    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 10, ttl: 60000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/test/data');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('9');
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();
  });

  it('honors external platform decisions without inventing remaining quota', async () => {
    let allowed = true;
    const storage: ThrottlerStore = {
      increment: async (_key, ttlMs) => ({
        count: 0,
        ttlMs,
        allowed,
      }),
      reset: () => undefined,
    };

    @Controller('/external-limit')
    class TestController {
      @Get()
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 2, ttl: 60000 }], storage })],
      controllers: [TestController],
    })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    const first = await hono.request('/external-limit');
    expect(first.status).toBe(200);
    expect(first.headers.get('X-RateLimit-Remaining')).toBeNull();

    allowed = false;
    const blocked = await hono.request('/external-limit');
    expect(blocked.status).toBe(429);
  });

  it('should set Retry-After header on 429 responses', async () => {
    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 1, ttl: 30000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/test/data');
    const blocked = await hono.request('/test/data');

    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get('Retry-After');
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(30);
  });

  it('should reset count after TTL expires', async () => {
    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 2, ttl: 50 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Use up the limit
    await hono.request('/test/data');
    await hono.request('/test/data');

    const blocked = await hono.request('/test/data');
    expect(blocked.status).toBe(429);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 60));

    const res = await hono.request('/test/data');
    expect(res.status).toBe(200);
  });

  it('@SkipThrottle() bypasses rate limiting on specific routes', async () => {
    @Controller('/test')
    class TestController {
      @Get('/limited')
      getLimited() {
        return { limited: true };
      }

      @Get('/unlimited')
      @SkipThrottle()
      getUnlimited() {
        return { unlimited: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 2, ttl: 60000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Exhaust limit on /limited
    await hono.request('/test/limited');
    await hono.request('/test/limited');
    const blocked = await hono.request('/test/limited');
    expect(blocked.status).toBe(429);

    // /unlimited should still work
    for (let i = 0; i < 10; i++) {
      const res = await hono.request('/test/unlimited');
      expect(res.status).toBe(200);
    }
  });

  it('@Throttle() overrides global config per-route', async () => {
    @Controller('/test')
    class TestController {
      @Get('/default')
      getDefault() {
        return { route: 'default' };
      }

      @Get('/custom')
      @Throttle({ default: { limit: 1, ttl: 60000 } })
      getCustom() {
        return { route: 'custom' };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 10, ttl: 60000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // /custom has limit: 1, so second request should be blocked
    const res1 = await hono.request('/test/custom');
    expect(res1.status).toBe(200);

    const res2 = await hono.request('/test/custom');
    expect(res2.status).toBe(429);

    // /default still has limit: 10
    for (let i = 0; i < 10; i++) {
      const res = await hono.request('/test/default');
      expect(res.status).toBe(200);
    }
  });

  it('should track different clients separately through a trusted runtime resolver', async () => {
    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 2, ttl: 60000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      getClientIp: (c) => c.req.header('x-runtime-client-ip') ?? null,
    });
    const hono = app.getHonoApp();

    // Client A uses up limit
    for (let i = 0; i < 2; i++) {
      await hono.request('/test/data', {
        headers: { 'x-runtime-client-ip': 'client-a' },
      });
    }
    const blockedA = await hono.request('/test/data', {
      headers: { 'x-runtime-client-ip': 'client-a' },
    });
    expect(blockedA.status).toBe(429);

    // Client B should still be allowed
    const resB = await hono.request('/test/data', {
      headers: { 'x-runtime-client-ip': 'client-b' },
    });
    expect(resB.status).toBe(200);
  });

  it('shares one fail-closed bucket when only spoofed forwarding headers differ', async () => {
    @Controller('/spoofed')
    class TestController {
      @Get()
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 1, ttl: 60000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    const first = await hono.request('/spoofed', {
      headers: { 'x-forwarded-for': 'client-a' },
    });
    const second = await hono.request('/spoofed', {
      headers: { 'x-forwarded-for': 'client-b' },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it('should support custom getTracker function', async () => {
    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ limit: 2, ttl: 60000 }],
          getTracker: (req) => req.headers.get('x-api-key') ?? 'no-key',
        }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Track by API key
    for (let i = 0; i < 2; i++) {
      await hono.request('/test/data', {
        headers: { 'x-api-key': 'key-1' },
      });
    }
    const blocked = await hono.request('/test/data', {
      headers: { 'x-api-key': 'key-1' },
    });
    expect(blocked.status).toBe(429);

    // Different key should work
    const res = await hono.request('/test/data', {
      headers: { 'x-api-key': 'key-2' },
    });
    expect(res.status).toBe(200);
  });

  it('tracks trusted principal and tenant before custom or runtime-address fallbacks', async () => {
    @Injectable()
    class VerifiedIdentityGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const request = context.getRequest();
        setTrustedRequestIdentity(request, {
          principal: {
            issuer: 'test-issuer',
            subject: request.headers.get('x-verified-subject') ?? 'unknown',
            principalType: 'user',
          },
          tenantId: request.headers.get('x-verified-tenant') ?? 'unknown',
        });
        return true;
      }
    }

    @Module({
      providers: [
        VerifiedIdentityGuard,
        defineProvider(APP_GUARD, { useExisting: VerifiedIdentityGuard }),
      ],
    })
    class IdentityModule {}

    @Controller('/trusted-throttle')
    class TestController {
      @Get()
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        IdentityModule,
        ThrottlerModule.forRoot({
          throttlers: [{ limit: 1, ttl: 60000 }],
          getTracker: () => 'collapsed-custom-fallback',
        }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      getClientIp: () => 'collapsed-ip-fallback',
    });
    const hono = app.getHonoApp();
    const requestAs = (subject: string, tenant: string) =>
      hono.request('/trusted-throttle', {
        headers: { 'x-verified-subject': subject, 'x-verified-tenant': tenant },
      });

    expect((await requestAs('user-a', 'tenant-a')).status).toBe(200);
    expect((await requestAs('user-a', 'tenant-a')).status).toBe(429);
    expect((await requestAs('user-b', 'tenant-a')).status).toBe(200);
    expect((await requestAs('user-a', 'tenant-b')).status).toBe(200);
  });

  it('passes the route execution context to an anonymous tracker fallback', async () => {
    let observed: ExecutionContext | undefined;

    @Controller('/context-tracker')
    class TestController {
      @Get()
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ limit: 1, ttl: 60000 }],
          getTracker: (_request, context) => {
            observed = context;
            return 'verified-api-key';
          },
        }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const response = await (
      await VelaFactory.create(AppModule)
    )
      .getHonoApp()
      .request('/context-tracker');
    expect(response.status).toBe(200);
    expect(observed?.getClass()).toBe(TestController);
    expect(observed?.getHandlerName()).toBe('getData');
    expect(observed?.getHandler()).toBe(TestController.prototype.getData);
  });

  it('rejects inherited or oversized trusted identity fields', () => {
    const request = new Request('https://api.example.test/resource');
    const inherited = Object.create({
      principal: { issuer: 'issuer', subject: 'subject', principalType: 'user' },
    });
    expect(() => setTrustedRequestIdentity(request, inherited)).toThrow(/principal.*own data/);

    expect(() =>
      setTrustedRequestIdentity(request, {
        principal: {
          issuer: 'issuer',
          subject: 'x'.repeat(257),
          principalType: 'user',
        },
      }),
    ).toThrow(/subject is invalid/);
  });

  it('should support custom storage backend', async () => {
    const records = new Map<string, { count: number; resetTime: number }>();

    const customStore: ThrottlerStore = {
      increment(key: string, ttlMs: number): ThrottlerStorageRecord {
        const now = Date.now();
        let entry = records.get(key);
        if (!entry || now >= entry.resetTime) {
          entry = { count: 0, resetTime: now + ttlMs };
        }
        entry.count++;
        records.set(key, entry);
        return { count: entry.count, ttlMs: entry.resetTime - now };
      },
      reset(key: string): void {
        records.delete(key);
      },
    };

    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ limit: 2, ttl: 60000 }], storage: customStore }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/test/data');
    await hono.request('/test/data');

    // Custom store should have tracked hits
    expect(records.size).toBe(1);

    const blocked = await hono.request('/test/data');
    expect(blocked.status).toBe(429);
  });

  it('should expose RateLimitInfo per throttler on the request context', async () => {
    let capturedInfo: Readonly<Record<string, RateLimitInfo>> | undefined;

    @Controller('/test')
    class TestController {
      @Get('/data')
      getData(@Ctx() c: VelaContext) {
        capturedInfo = getRequestContainer(c).resolve(REQUEST_CONTEXT).get(RATE_LIMIT);
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 5, ttl: 60000 }] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/test/data');

    expect(capturedInfo).toEqual({
      default: { limit: 5, remaining: 4, reset: expect.any(Number) },
    });
  });
});

describe('named throttlers (Nest v5)', () => {
  /** A memory store that records every increment it serves. */
  function recordingStore() {
    const counts = new Map<string, number>();
    const calls: Array<{ key: string; ttl: number; limit: number; name: string }> = [];
    const store: ThrottlerStore = {
      increment(key, ttl, limit, name) {
        calls.push({ key, ttl, limit, name });
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { count, ttlMs: ttl };
      },
      reset(key) {
        counts.delete(key);
      },
    };
    return { store, calls };
  }

  it('counts each named throttler independently and blocks on the first one exceeded', async () => {
    const { store, calls } = recordingStore();
    @Controller('/named')
    class Named {
      @Get() read() {
        return { ok: true };
      }
    }
    @Module({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'short', ttl: 1_000, limit: 2 },
            { name: 'long', ttl: 60_000, limit: 3 },
          ],
          storage: store,
        }),
      ],
      controllers: [Named],
    })
    class App {}
    const hono = (await VelaFactory.create(App)).getHonoApp();

    const first = await hono.request('/named');
    expect(first.status).toBe(200);
    expect(first.headers.get('X-RateLimit-Limit-short')).toBe('2');
    expect(first.headers.get('X-RateLimit-Remaining-short')).toBe('1');
    expect(first.headers.get('X-RateLimit-Limit-long')).toBe('3');
    expect(first.headers.get('X-RateLimit-Remaining-long')).toBe('2');
    expect(first.headers.get('X-RateLimit-Limit')).toBeNull();
    expect((await hono.request('/named')).status).toBe(200);
    const blocked = await hono.request('/named');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After-short')).toBe('1');

    const keys = new Set(calls.map(({ key }) => key));
    expect(new Set(calls.map(({ name }) => name))).toEqual(new Set(['short', 'long']));
    // One bucket per throttler: the names never share a counter.
    expect(keys.size).toBe(2);
    // The blocked request stopped at 'short', so 'long' counted only the two that passed.
    expect(
      calls.filter(({ name }) => name === 'long').map(({ ttl, limit }) => [ttl, limit]),
    ).toEqual([
      [60_000, 3],
      [60_000, 3],
    ]);
  });

  it('overrides and skips throttlers by name with @Throttle and @SkipThrottle', async () => {
    const { store, calls } = recordingStore();
    @Controller('/by-name')
    class ByName {
      @Get('/strict') @Throttle({ long: { limit: 1 } }) strict() {
        return { ok: true };
      }
      @Get('/no-short') @SkipThrottle({ short: true }) noShort() {
        return { ok: true };
      }
      @Get('/no-default') @SkipThrottle() noDefault() {
        return { ok: true };
      }
    }
    @Module({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'short', ttl: 1_000, limit: 10 },
            { name: 'long', ttl: 60_000, limit: 10 },
          ],
          storage: store,
        }),
      ],
      controllers: [ByName],
    })
    class App {}
    const hono = (await VelaFactory.create(App)).getHonoApp();

    expect((await hono.request('/by-name/strict')).status).toBe(200);
    expect((await hono.request('/by-name/strict')).status).toBe(429);
    expect(calls.at(-1)).toMatchObject({ name: 'long', limit: 1, ttl: 60_000 });

    calls.length = 0;
    await hono.request('/by-name/no-short');
    expect(calls.map(({ name }) => name)).toEqual(['long']);

    // @SkipThrottle() skips only the 'default' throttler, as in Nest.
    calls.length = 0;
    await hono.request('/by-name/no-default');
    expect(calls.map(({ name }) => name)).toEqual(['short', 'long']);
  });

  it('names the default throttler "default" and keeps unsuffixed headers for it', async () => {
    @Controller('/plain')
    class Plain {
      @Get() read() {
        return { ok: true };
      }
    }
    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 1 }] })],
      controllers: [Plain],
    })
    class App {}
    const hono = (await VelaFactory.create(App)).getHonoApp();
    const res = await hono.request('/plain');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('1');
    const blocked = await hono.request('/plain');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
  });

  it('builds the storage from each application ENV', async () => {
    const seen: VelaEnv[] = [];
    @Controller('/env-store')
    class EnvStore {
      @Get() read() {
        return { ok: true };
      }
    }
    @Module({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 60_000, limit: 5 }],
          storage: (env) => {
            seen.push(env);
            return recordingStore().store;
          },
        }),
      ],
      controllers: [EnvStore],
    })
    class App {}
    await VelaFactory.create(App, { env: { REGION: 'east' } });
    await VelaFactory.create(App, { env: { REGION: 'west' } });
    expect(seen.map((env) => Reflect.get(env, 'REGION'))).toEqual(['east', 'west']);
  });

  it('refuses, at bootstrap, route overrides a fixed-limit platform store cannot enforce', async () => {
    const store: ThrottlerStore = {
      fixedLimits: true,
      increment: (_key, ttl) => ({ count: 0, ttlMs: ttl, allowed: true }),
      reset: () => undefined,
    };
    const fixed = (controller: Type) => {
      @Module({
        imports: [
          ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 5 }], storage: store }),
        ],
        controllers: [controller],
      })
      class App {}
      return VelaFactory.create(App);
    };
    @Controller('/fixed')
    class Same {
      @Get() @Throttle({ default: { limit: 5, ttl: 60_000 } }) same() {
        return { ok: true };
      }
    }
    const hono = (await fixed(Same)).getHonoApp();
    expect((await hono.request('/fixed')).status).toBe(200);

    @Controller('/fixed')
    class Other {
      @Get() @Throttle({ default: { limit: 1 } }) other() {
        return { ok: true };
      }
    }
    await expect(fixed(Other)).rejects.toThrow(
      "enforces throttler 'default' at its declared 5 requests per 60000ms",
    );
  });

  it('lets the store check the declared throttlers at bootstrap, before any request', async () => {
    const validated: Array<readonly Required<ThrottlerOptions>[]> = [];
    const store: ThrottlerStore = {
      increment: (_key, ttl) => ({ count: 0, ttlMs: ttl, allowed: true }),
      reset: () => undefined,
      validate(throttlers) {
        validated.push(throttlers);
        const long = throttlers.find(({ ttl }) => ttl > 60_000);
        if (long) throw new Error(`the store cannot serve throttler '${long.name}'`);
      },
    };
    const bootstrap = (throttlers: ThrottlerOptions[]) => {
      @Module({ imports: [ThrottlerModule.forRoot({ throttlers, storage: store })] })
      class App {}
      return VelaFactory.create(App);
    };
    await bootstrap([
      { ttl: 60_000, limit: 5 },
      { name: 'burst', ttl: 1_000, limit: 2 },
    ]);
    expect(validated).toEqual([
      [
        { name: 'default', ttl: 60_000, limit: 5 },
        { name: 'burst', ttl: 1_000, limit: 2 },
      ],
    ]);
    await expect(bootstrap([{ name: 'daily', ttl: 86_400_000, limit: 5 }])).rejects.toThrow(
      "the store cannot serve throttler 'daily'",
    );
  });

  it('rejects unknown throttler names at bootstrap, on routes and controllers', async () => {
    const bootstrapWith = (controller: Type) => {
      @Module({
        imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 5 }] })],
        controllers: [controller],
      })
      class App {}
      return VelaFactory.create(App);
    };
    @Controller('/unknown')
    class OnRoute {
      @Get() @Throttle({ burst: { limit: 1 } }) read() {
        return { ok: true };
      }
    }
    await expect(bootstrapWith(OnRoute)).rejects.toThrow(
      "@Throttle() on OnRoute.read names throttler 'burst'",
    );

    // A route's own @Throttle() does not hide a typo on its controller.
    @Controller('/unknown')
    @Throttle({ defualt: { limit: 1 } })
    class OnController {
      @Get() @Throttle({ default: { limit: 2 } }) read() {
        return { ok: true };
      }
    }
    await expect(bootstrapWith(OnController)).rejects.toThrow(
      "@Throttle() on OnController names throttler 'defualt'",
    );
  });

  it('checks the @Throttle() declarations a controller inherits at bootstrap, as the guard reads them', async () => {
    const store: ThrottlerStore = {
      fixedLimits: true,
      increment: (_key, ttl) => ({ count: 0, ttlMs: ttl, allowed: true }),
      reset: () => undefined,
    };
    const bootstrapWith = (controller: Type, storage?: ThrottlerStore) => {
      @Module({
        imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 5 }], storage })],
        controllers: [controller],
      })
      class App {}
      return VelaFactory.create(App);
    };

    // On an ancestor class.
    @Throttle({ burst: { limit: 1 } })
    abstract class ThrottledBase {}
    @Controller('/inherited-class')
    class InheritedClass extends ThrottledBase {
      @Get() read() {
        return { ok: true };
      }
    }
    await expect(bootstrapWith(InheritedClass)).rejects.toThrow(
      "@Throttle() on InheritedClass names throttler 'burst'",
    );

    // On a method the controller routes unchanged.
    class LimitedBase {
      @Throttle({ default: { limit: 1 } })
      read() {
        return { ok: true };
      }
    }
    @Controller('/inherited-method')
    class InheritedMethod extends LimitedBase {}
    Get()(
      InheritedMethod.prototype,
      'read',
      Object.getOwnPropertyDescriptor(LimitedBase.prototype, 'read')!,
    );
    await expect(bootstrapWith(InheritedMethod, store)).rejects.toThrow(
      "enforces throttler 'default' at its declared 5 requests per 60000ms",
    );

    // An override reads only its own declarations.
    @Controller('/overridden')
    class Overridden extends LimitedBase {
      @Get() override read() {
        return { ok: true };
      }
    }
    const hono = (await bootstrapWith(Overridden, store)).getHonoApp();
    expect((await hono.request('/overridden')).status).toBe(200);
  });

  it('rejects @Throttle() limits and windows that are not positive integers', () => {
    for (const config of [
      { limit: Number.NaN },
      { limit: Number.POSITIVE_INFINITY },
      { limit: 0 },
      { ttl: 1.5 },
      { ttl: -1_000 },
    ]) {
      expect(() => Throttle({ default: config })).toThrow(/throttler 'default' (limit|ttl)/);
    }
  });

  it('overrides limit and ttl separately, a route field over its controller field, as Nest v5', async () => {
    const { store, calls } = recordingStore();
    @Controller('/partial')
    @Throttle({ default: { ttl: 1_000 } })
    class Partial {
      @Get() @Throttle({ default: { limit: 1 } }) read() {
        return { ok: true };
      }
      @Get('/inherited') inherited() {
        return { ok: true };
      }
    }
    @Module({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }], storage: store }),
      ],
      controllers: [Partial],
    })
    class App {}
    const hono = (await VelaFactory.create(App)).getHonoApp();
    const response = await hono.request('/partial');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('1');
    expect(calls.at(-1)).toMatchObject({ ttl: 1_000, limit: 1 });
    await hono.request('/partial/inherited');
    expect(calls.at(-1)).toMatchObject({ ttl: 1_000, limit: 100 });
  });

  it('rejects invalid throttler declarations', async () => {
    @Controller('/declared')
    class Unknown {
      @Get() read() {
        return { ok: true };
      }
    }
    const bootstrap = (throttlers: ThrottlerOptions[]) => {
      @Module({ imports: [ThrottlerModule.forRoot({ throttlers })], controllers: [Unknown] })
      class Invalid {}
      return VelaFactory.create(Invalid);
    };
    await expect(bootstrap([])).rejects.toThrow('at least one throttler');
    await expect(
      bootstrap([
        { name: 'a', ttl: 1_000, limit: 1 },
        { name: 'a', ttl: 2_000, limit: 1 },
      ]),
    ).rejects.toThrow("throttler 'a' is declared twice");
    await expect(bootstrap([{ ttl: 0, limit: 1 }])).rejects.toThrow('ttl');
    await expect(bootstrap([{ ttl: 1_000, limit: 1.5 }])).rejects.toThrow('limit');
  });
});
