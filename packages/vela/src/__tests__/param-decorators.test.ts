import { describe, it, expect } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Module,
  Injectable,
  Cookie,
  Cookies,
  RawBody,
} from '../index.js';

// =============================================================================
// @Cookie() / @Cookies()
// =============================================================================

describe('@Cookie() / @Cookies()', () => {
  it('should inject a single cookie by name', async () => {
    @Controller('/cookie')
    class CookieController {
      @Get()
      handle(@Cookie('session') session: string) {
        return { session };
      }
    }

    @Module({ controllers: [CookieController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/cookie', {
      headers: { cookie: 'session=abc123; other=xyz' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: 'abc123' });
  });

  it('should return undefined for a missing cookie', async () => {
    @Controller('/cookie-missing')
    class CookieController {
      @Get()
      handle(@Cookie('token') token: string | undefined) {
        return { token: token ?? null };
      }
    }

    @Module({ controllers: [CookieController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/cookie-missing', {
      headers: { cookie: 'other=value' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null });
  });

  it('@Cookies() with no name returns all cookies as an object', async () => {
    @Controller('/cookies-all')
    class CookiesController {
      @Get()
      handle(@Cookies() cookies: Record<string, string>) {
        return cookies;
      }
    }

    @Module({ controllers: [CookiesController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/cookies-all', {
      headers: { cookie: 'a=1; b=hello%20world; c=3' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: '1', b: 'hello world', c: '3' });
  });

  it('should work with no Cookie header (returns empty object)', async () => {
    @Controller('/no-cookies')
    class NoCookieController {
      @Get()
      handle(@Cookies() cookies: Record<string, string>) {
        return { count: Object.keys(cookies).length };
      }
    }

    @Module({ controllers: [NoCookieController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/no-cookies');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
  });

  it('should inject cookie inside an injectable service', async () => {
    @Injectable()
    class AuthService {
      verify(token: string | undefined) {
        return token === 'valid-token';
      }
    }

    @Controller('/auth-cookie')
    class AuthController {
      constructor(private auth: AuthService) {}

      @Get()
      handle(@Cookie('auth') token: string | undefined) {
        return { ok: this.auth.verify(token) };
      }
    }

    @Module({ providers: [AuthService], controllers: [AuthController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    const denied = await app.getHonoApp().request('/auth-cookie', {
      headers: { cookie: 'auth=bad-token' },
    });
    expect(await denied.json()).toEqual({ ok: false });

    const allowed = await app.getHonoApp().request('/auth-cookie', {
      headers: { cookie: 'auth=valid-token' },
    });
    expect(await allowed.json()).toEqual({ ok: true });
  });
});

// =============================================================================
// @RawBody()
// =============================================================================

describe('@RawBody()', () => {
  it('should inject request body as Uint8Array', async () => {
    @Controller('/raw')
    class RawController {
      @Post()
      handle(@RawBody() body: Uint8Array) {
        return { byteLength: body.byteLength, isUint8Array: body instanceof Uint8Array };
      }
    }

    @Module({ controllers: [RawController] })
    class AppModule {}

    const payload = new TextEncoder().encode('hello world');
    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/raw', {
      method: 'POST',
      body: payload,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ byteLength: 11, isUint8Array: true });
  });

  it('should allow HMAC-style verification from raw bytes', async () => {
    @Controller('/webhook')
    class WebhookController {
      @Post()
      async handle(@RawBody() body: Uint8Array) {
        const text = new TextDecoder().decode(body);
        const parsed = JSON.parse(text) as { event: string };
        return { received: parsed.event };
      }
    }

    @Module({ controllers: [WebhookController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment.succeeded' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: 'payment.succeeded' });
  });

  it('should return empty Uint8Array for empty body', async () => {
    @Controller('/raw-empty')
    class RawEmptyController {
      @Post()
      handle(@RawBody() body: Uint8Array) {
        return { byteLength: body.byteLength };
      }
    }

    @Module({ controllers: [RawEmptyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/raw-empty', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ byteLength: 0 });
  });
});
