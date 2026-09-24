import { describe, it, expect } from 'vitest';
import {
  Controller,
  Get,
  Module,
  Post,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type CorsOptions,
} from '../index.js';
import * as security from '../security/index.js';

@Controller('/test')
class TestController {
  @Get('/hello')
  hello() {
    return { message: 'hello' };
  }
}

@Module({ controllers: [TestController] })
class AppModule {}

const fromOrigin = (origin: string, init: RequestInit = {}) => ({
  ...init,
  headers: { Origin: origin, ...(init.headers as Record<string, string> | undefined) },
});

describe('CORS (Nest-style enableCors and the cors factory option)', () => {
  it('adds CORS headers from the cors factory option', async () => {
    const app = await VelaFactory.create(AppModule, { cors: { origin: '*' } });
    const res = await app.getHonoApp().request('/test/hello', fromOrigin('http://example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('treats cors: true as a wildcard origin, as Nest does', async () => {
    const app = await VelaFactory.create(AppModule, { cors: true });
    const res = await app.getHonoApp().request('/test/hello', fromOrigin('http://example.com'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('enables CORS on a built application with app.enableCors(), no rebuild needed', async () => {
    const app = await VelaFactory.create(AppModule);
    const before = await app.getHonoApp().request('/test/hello', fromOrigin('http://allowed.com'));
    expect(before.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(app.enableCors({ origin: 'http://allowed.com' })).toBe(app);
    const after = await app.getHonoApp().request('/test/hello', fromOrigin('http://allowed.com'));
    expect(after.headers.get('Access-Control-Allow-Origin')).toBe('http://allowed.com');
  });

  it('answers preflight OPTIONS requests before routing and guards', async () => {
    class DenyAll implements CanActivate {
      canActivate() {
        return false;
      }
    }
    @Controller('/guarded')
    @UseGuards(DenyAll)
    class Guarded {
      @Post() create() {
        return { ok: true };
      }
    }
    @Module({ controllers: [Guarded], providers: [DenyAll] })
    class GuardedApp {}
    const app = await VelaFactory.create(GuardedApp);
    app.enableCors({ origin: 'http://example.com', allowMethods: ['GET', 'POST'] });
    const preflight = await app.getHonoApp().request(
      '/guarded',
      fromOrigin('http://example.com', {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'POST' },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    // The actual request still runs the guard, and its refusal is readable cross-origin.
    const denied = await app
      .getHonoApp()
      .request('/guarded', fromOrigin('http://example.com', { method: 'POST' }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBe('http://example.com');
  });

  it('supports credentials and custom headers', async () => {
    const options: CorsOptions = {
      origin: ['http://example.com'],
      credentials: true,
      exposeHeaders: ['X-Custom-Header'],
      allowHeaders: ['X-Requested-With'],
      maxAge: 600,
    };
    const app = await VelaFactory.create(AppModule, { cors: options });
    const res = await app.getHonoApp().request('/test/hello', fromOrigin('http://example.com'));
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Custom-Header');
    const preflight = await app.getHonoApp().request(
      '/test/hello',
      fromOrigin('http://example.com', {
        method: 'OPTIONS',
        headers: {
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'X-Requested-With',
        },
      }),
    );
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('X-Requested-With');
    expect(preflight.headers.get('Access-Control-Max-Age')).toBe('600');
  });

  it('rejects credentialed wildcard origins and invalid preflight lifetimes', async () => {
    await expect(
      VelaFactory.create(AppModule, { cors: { origin: '*', credentials: true } }),
    ).rejects.toThrow('credentials');
    const app = await VelaFactory.create(AppModule);
    expect(() => app.enableCors({ maxAge: -1 })).toThrow('maxAge');
  });

  it('has no CorsModule', () => {
    expect('CorsModule' in security).toBe(false);
    expect('CORS_OPTIONS' in security).toBe(false);
  });
});
