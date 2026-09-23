import { describe, it, expect } from 'vitest';
import type { VelaMiddlewareHandler } from '@velajs/vela';
import { Controller, Get, Ip, Module, VelaFactory } from '@velajs/vela';
import { ThrottlerModule } from '@velajs/vela/throttler';
import { cloudflareAdapter, createCloudflareApp } from '../cloudflare-factory';
const env = {};

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

    const app = await createCloudflareApp(AppModule, { env, globalPrefix: '/api' });
    const hono = app.getHonoApp();

    // With globalPrefix '/api', the controller path '/users' is mounted at '/api/users'.
    const prefixed = await hono.request('/api/users', undefined, env);
    expect(prefixed.status).toBe(200);
    expect(await prefixed.json()).toEqual({ users: ['alice', 'bob'] });

    // The unprefixed path must NOT resolve when a global prefix is set.
    const unprefixed = await hono.request('/users', undefined, env);
    expect(unprefixed.status).toBe(404);
  });

  it('runs caller-supplied middleware on every request', async () => {
    const markerMw: VelaMiddlewareHandler = async (c, next) => {
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
    const observerMw: VelaMiddlewareHandler = async (c, next) => {
      observedMarker = c.get('marker');
      await next();
    };

    const app = await createCloudflareApp(AppModule, {
      env,
      middleware: (bindings) => {
        expect(bindings).toBe(env);
        return [markerMw, observerMw];
      },
    });
    const hono = app.getHonoApp();

    const res = await hono.request('/marker', undefined, env);
    expect(res.status).toBe(200);
    expect(observedMarker).toBe('ran');
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

    const app = await createCloudflareApp(AppModule, { env });
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
      env,
    );
    expect(await trusted.json()).toEqual({ ip: '203.0.113.9' });

    const spoofOnly = await hono.request(
      '/ip',
      { headers: { 'x-forwarded-for': '198.51.100.1' } },
      env,
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

    const hono = (await createCloudflareApp(AppModule, { env })).getHonoApp();
    const first = await hono.request(
      '/limited',
      { headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': 'a' } },
      env,
    );
    const spoofChanged = await hono.request(
      '/limited',
      { headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': 'b' } },
      env,
    );
    const otherClient = await hono.request(
      '/limited',
      { headers: { 'cf-connecting-ip': '203.0.113.2', 'x-forwarded-for': 'a' } },
      env,
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

    const app = await VelaFactory.create(AppModule, {
      adapters: [cloudflareAdapter({ env })],
    });
    const response = await app.getHonoApp().request(
      '/direct-ip',
      {
        headers: { 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': 'spoofed' },
      },
      env,
    );
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
        env,
        security: { query: { maxParameters: 1 } },
      })
    ).getHonoApp();
    const response = await hono.request('/bounded?a=1&b=2', undefined, env);
    expect(response.status).toBe(400);
  });
});
