import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from 'hono';
import { Controller, Get, Ip, Module, VelaFactory, type VelaEnv } from '@velajs/vela';
import { ThrottlerModule } from '@velajs/vela/throttler';
import {
  cloudflareAdapter,
  createCloudflareApp,
  createCloudflareWorker,
} from '../cloudflare-factory';
const env = {};
const httpContext: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

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

  it("finishes each environment's HTTP surface once, before concurrent cold events see it", async () => {
    @Controller('/marker')
    class MarkerController {
      @Get()
      read() {
        return { ok: true };
      }
    }
    @Module({ controllers: [MarkerController] })
    class AppModule {}

    const configured: Array<{ env: VelaEnv; built: boolean }> = [];
    const worker = createCloudflareWorker(AppModule, {
      configure(app, bindings) {
        const hono = app.getHonoApp();
        configured.push({
          env: bindings,
          built: hono.routes.some((route) => route.path === '/marker'),
        });
        hono.get('/configured', (c) => c.text('configured'));
      },
    });
    const first = {};
    const second = {};
    const responses = await Promise.all([
      worker.fetch(new Request('https://worker/configured'), first, httpContext),
      worker.fetch(new Request('https://worker/configured'), first, httpContext),
      worker.fetch(new Request('https://worker/marker'), second, httpContext),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await responses[0]?.text()).toBe('configured');
    expect(configured.map(({ env: bindings }) => bindings)).toEqual([first, second]);
    // The application is built, routes included, before configure runs.
    expect(configured.every(({ built }) => built)).toBe(true);
  });

  it('fails the construction configure throws in, and retries on the next event', async () => {
    @Module({})
    class AppModule {}

    let failures = 1;
    const worker = createCloudflareWorker(AppModule, {
      configure(app) {
        if (failures-- > 0) throw new Error('configure failed');
        app.getHonoApp().get('/ready', (c) => c.text('ready'));
      },
    });
    const bindings = {};

    await expect(
      worker.fetch(new Request('https://worker/ready'), bindings, httpContext),
    ).rejects.toThrow('configure failed');
    const retried = await worker.fetch(new Request('https://worker/ready'), bindings, httpContext);
    expect(await retried.text()).toBe('ready');
  });

  it('refuses an asynchronous configure, which could do I/O outside an event', async () => {
    @Module({})
    class AppModule {}

    const worker = createCloudflareWorker(AppModule, {
      configure: async (app) => {
        app.getHonoApp().get('/late', (c) => c.text('late'));
      },
    });

    await expect(worker.fetch(new Request('https://worker/late'), {}, httpContext)).rejects.toThrow(
      /configure must finish synchronously/,
    );
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

  it('enables CORS from the cors option and from app.enableCors() in configure', async () => {
    @Controller('/data')
    class DataController {
      @Get() read() {
        return { ok: true };
      }
    }
    @Module({ controllers: [DataController] })
    class AppModule {}
    const request = () =>
      new Request('https://worker.test/data', { headers: { Origin: 'https://app.test' } });

    const option = createCloudflareWorker(AppModule, { cors: { origin: 'https://app.test' } });
    const optionRes = await option.fetch(request(), {}, httpContext);
    expect(optionRes.headers.get('access-control-allow-origin')).toBe('https://app.test');

    const configured = createCloudflareWorker(AppModule, {
      configure: (app) => {
        app.enableCors({ origin: ['https://app.test'] });
      },
    });
    const configuredRes = await configured.fetch(request(), {}, httpContext);
    expect(configuredRes.headers.get('access-control-allow-origin')).toBe('https://app.test');
    const preflight = await configured.fetch(
      new Request('https://worker.test/data', {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'GET' },
      }),
      {},
      httpContext,
    );
    expect(preflight.status).toBe(204);
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
