import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module, Post, SecurityModule, VelaFactory } from '../index.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('SecurityModule', () => {
  it('allows an absent Origin only when opted in, while rejecting invalid origins and preflights', async () => {
    let mutations = 0;
    @Controller('/compat')
    class CompatController {
      @Post()
      mutate() {
        return { mutations: ++mutations };
      }
    }
    @Module({
      imports: [SecurityModule.forRoot({ originProtection: { allowMissingOrigin: true } })],
      controllers: [CompatController],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const hono = app.getHonoApp();
      const accepted = await hono.request('https://api.example/compat', {
        method: 'POST',
        headers: { cookie: 'session=test' },
      });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get('x-content-type-options')).toBe('nosniff');
      for (const origin of ['', 'null', 'garbage', 'https://evil.example']) {
        const response = await hono.request('https://api.example/compat', {
          method: 'POST',
          headers: { cookie: 'session=test', origin },
        });
        expect(response.status).toBe(403);
      }
      expect(
        (
          await hono.request('https://api.example/compat', {
            method: 'OPTIONS',
            headers: { 'access-control-request-method': 'POST' },
          })
        ).status,
      ).toBe(403);
      expect(mutations).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('adds restrictive browser security headers, including HSTS only on HTTPS', async () => {
    @Controller('/headers')
    class HeadersController {
      @Get()
      get() {
        return { ok: true };
      }
    }

    @Module({ imports: [SecurityModule.forRoot({})], controllers: [HeadersController] })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    const secure = await hono.request('https://api.example/headers');
    expect(secure.headers.get('x-content-type-options')).toBe('nosniff');
    expect(secure.headers.get('referrer-policy')).toBe('no-referrer');
    expect(secure.headers.get('x-frame-options')).toBe('DENY');
    expect(secure.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(secure.headers.get('strict-transport-security')).toContain('max-age=31536000');

    const insecure = await hono.request('http://api.example/headers');
    expect(insecure.headers.get('strict-transport-security')).toBeNull();
  });

  it('rejects credentialed state changes without an exact allowed Origin', async () => {
    let mutations = 0;

    @Controller('/state')
    class StateController {
      @Post()
      mutate() {
        mutations++;
        return { mutations };
      }
    }

    @Module({
      imports: [
        SecurityModule.forRoot({
          allowedOrigins: ['https://app.example'],
          cors: { allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'] },
        }),
      ],
      controllers: [StateController],
    })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    const missing = await hono.request('https://api.example/state', {
      method: 'POST',
      headers: { cookie: 'session=secret' },
    });
    const evil = await hono.request('https://api.example/state', {
      method: 'POST',
      headers: { cookie: 'session=secret', origin: 'https://evil.example' },
    });
    const sameOrigin = await hono.request('https://api.example/state', {
      method: 'POST',
      headers: { cookie: 'session=secret', origin: 'https://api.example' },
    });
    const allowedCrossOrigin = await hono.request('https://api.example/state', {
      method: 'POST',
      headers: { cookie: 'session=secret', origin: 'https://app.example' },
    });

    expect(missing.status).toBe(403);
    expect(evil.status).toBe(403);
    expect(sameOrigin.status).toBe(200);
    expect(allowedCrossOrigin.status).toBe(200);
    expect(allowedCrossOrigin.headers.get('access-control-allow-origin')).toBe(
      'https://app.example',
    );
    expect(mutations).toBe(2);
  });

  it('allows only configured preflight methods and headers', async () => {
    @Controller('/cors')
    class CorsController {
      @Post()
      post() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        SecurityModule.forRoot({
          allowedOrigins: ['https://app.example'],
          cors: {
            allowMethods: ['GET', 'POST', 'OPTIONS'],
            allowHeaders: ['content-type'],
          },
        }),
      ],
      controllers: [CorsController],
    })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    const allowed = await hono.request('https://api.example/cors', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

    const badHeader = await hono.request('https://api.example/cors', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-untrusted',
      },
    });
    expect(badHeader.status).toBe(403);
  });

  it('rejects wildcard/URL-shaped origin allowlist mistakes at bootstrap', async () => {
    expect(() => SecurityModule.forRoot({ allowedOrigins: ['*'] })).toThrow(/wildcard origins/);
    expect(() => SecurityModule.forRoot({ allowedOrigins: ['https://app.example/path'] })).toThrow(
      /invalid origin/,
    );
  });

  it('warns in production when request parsing limits are raised or disabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    @Module({})
    class AppModule {}

    await VelaFactory.create(AppModule, {
      security: {
        body: {
          maxBytes: 2 * 1024 * 1024,
          streamingOverrides: [{ path: '/stream/*', maxBytes: false }],
        },
        query: { maxParameters: false, maxDepth: 6, maxBytes: 16 * 1024 },
      },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('security.body.maxBytes'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('streamingOverrides[/stream/*]'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('security.query.maxParameters'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('security.query.maxDepth'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('security.query.maxBytes'));
  });
});
