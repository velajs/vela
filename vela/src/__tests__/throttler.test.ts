import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  APP_GUARD,
  VelaFactory,
  Controller,
  Get,
  Injectable,
  Module,
  MetadataRegistry,
  setTrustedRequestIdentity,
} from '../index.js';
import { ThrottlerModule, Throttle, SkipThrottle } from '../throttler/index.js';
import type { CanActivate, ExecutionContext } from '../index.js';
import type { ThrottlerStore, ThrottlerStorageRecord } from '../throttler/index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

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
      imports: [ThrottlerModule.forRoot({ limit: 5, ttl: 60000 })],
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
      imports: [ThrottlerModule.forRoot({ limit: 3, ttl: 60000 })],
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
      imports: [ThrottlerModule.forRoot({ limit: 10, ttl: 60000 })],
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
        enforcedLimit: 2,
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
      imports: [ThrottlerModule.forRoot({ limit: 2, ttl: 60000, storage })],
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
      imports: [ThrottlerModule.forRoot({ limit: 1, ttl: 30000 })],
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
      imports: [ThrottlerModule.forRoot({ limit: 2, ttl: 50 })],
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
      imports: [ThrottlerModule.forRoot({ limit: 2, ttl: 60000 })],
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
      @Throttle({ limit: 1, ttl: 60000 })
      getCustom() {
        return { route: 'custom' };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ limit: 10, ttl: 60000 })],
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
      imports: [ThrottlerModule.forRoot({ limit: 2, ttl: 60000 })],
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
      imports: [ThrottlerModule.forRoot({ limit: 1, ttl: 60000 })],
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
          limit: 2,
          ttl: 60000,
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
        defineProvider(APP_GUARD, {useExisting: VerifiedIdentityGuard}),
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
          limit: 1,
          ttl: 60000,
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
          limit: 1,
          ttl: 60000,
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
    expect(observed?.getHandler()).toBe('getData');
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
      imports: [ThrottlerModule.forRoot({ limit: 2, ttl: 60000, storage: customStore })],
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

  it('should expose RateLimitInfo on Hono context', async () => {
    let capturedInfo: unknown = undefined;

    @Controller('/test')
    class TestController {
      @Get('/data')
      getData() {
        return { ok: true };
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ limit: 5, ttl: 60000 })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Register middleware before routes to capture rateLimit info
    const { Hono } = await import('hono');
    const wrapper = new Hono();
    wrapper.use('*', async (c, next) => {
      await next();
      capturedInfo = c.get('rateLimit');
    });
    wrapper.route('/', hono);

    await wrapper.request('/test/data');

    expect(capturedInfo).toEqual({
      limit: 5,
      remaining: 4,
      reset: expect.any(Number),
    });
  });
});
