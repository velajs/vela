import { describe, it, expect } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Headers,
  Res,
  Module,
  Injectable,
  Inject,
  UseInterceptors,
} from '../index.js';
import {
  CacheModule,
  CacheInterceptor,
  CacheService,
  Cacheable,
  CacheKey,
  CacheTTL,
  CACHE_MANAGER,
} from '../cache/index.js';

describe('CacheModule', () => {
  it('should cache GET responses (handler called once for same URL)', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/data')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      getData() {
        callCount++;
        return { value: 'hello' };
      }
    }

    @Module({
      imports: [CacheModule.forRoot()],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/test/data');
    expect(await res1.json()).toEqual({ value: 'hello' });

    const res2 = await hono.request('/test/data');
    expect(await res2.json()).toEqual({ value: 'hello' });

    expect(callCount).toBe(1);
  });

  it('should cache different URLs separately', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/a')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      getA() {
        callCount++;
        return { path: 'a' };
      }

      @Get('/b')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      getB() {
        callCount++;
        return { path: 'b' };
      }
    }

    @Module({
      imports: [CacheModule.forRoot()],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/test/a');
    await hono.request('/test/b');
    expect(callCount).toBe(2);

    // Cached now
    await hono.request('/test/a');
    await hono.request('/test/b');
    expect(callCount).toBe(2);
  });

  it('scopes @CacheKey beneath the canonical route path', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/x')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      @CacheKey('custom-key')
      getX() {
        callCount++;
        return { x: true };
      }

      @Get('/y')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      @CacheKey('custom-key')
      getY() {
        callCount++;
        return { y: true };
      }
    }

    @Module({
      imports: [CacheModule.forRoot()],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/test/x');
    expect(await res1.json()).toEqual({ x: true });

    // A duplicate decorator key never lets one route read another route's value.
    const res2 = await hono.request('/test/y');
    expect(await res2.json()).toEqual({ y: true });
    expect(callCount).toBe(2);

    await hono.request('/test/x');
    await hono.request('/test/y');
    expect(callCount).toBe(2);
  });

  it('should support @CacheTTL and expire entries', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/ttl')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      @CacheTTL(0) // 0 seconds = expires immediately
      getTtl() {
        callCount++;
        return { count: callCount };
      }
    }

    @Module({
      imports: [CacheModule.forRoot()],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/test/ttl');
    expect(await res1.json()).toEqual({ count: 1 });

    // Wait a tiny bit for TTL to expire
    await new Promise((r) => setTimeout(r, 10));

    const res2 = await hono.request('/test/ttl');
    expect(await res2.json()).toEqual({ count: 2 });
    expect(callCount).toBe(2);
  });

  it('should not cache non-GET requests', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/data')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      getData() {
        callCount++;
        return { value: callCount };
      }
    }

    @Module({
      imports: [CacheModule.forRoot()],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // GET is cached
    await hono.request('/test/data');
    await hono.request('/test/data');
    expect(callCount).toBe(1);
  });

  it('should cache only explicitly @Cacheable routes when globalInterceptor: true', async () => {
    let cacheableCalls = 0;
    let plainCalls = 0;

    @Controller('/test')
    class TestController {
      @Get('/global')
      @Cacheable()
      getGlobal() {
        cacheableCalls++;
        return { global: true };
      }

      @Get('/plain')
      getPlain() {
        plainCalls++;
        return { plainCalls };
      }
    }

    @Module({
      imports: [CacheModule.forRoot({ globalInterceptor: true })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/test/global');
    await hono.request('/test/global');
    await hono.request('/test/plain');
    await hono.request('/test/plain');
    expect(cacheableCalls).toBe(1);
    expect(plainCalls).toBe(2);
  });

  it('should evict entries when max is reached', async () => {
    @Controller('/test')
    class TestController {
      @Get('/1')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get1() {
        return { id: 1 };
      }

      @Get('/2')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get2() {
        return { id: 2 };
      }

      @Get('/3')
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get3() {
        return { id: 3 };
      }
    }

    @Module({
      imports: [CacheModule.forRoot({ max: 2 })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/test/1');
    await hono.request('/test/2');
    await hono.request('/test/3'); // Should evict /test/1

    // Verify /test/3 is cached
    const store = app.get(CACHE_MANAGER);
    expect(store.get('cache:GET:localhost/test/3')).toEqual({ id: 3 });
    // /test/1 should have been evicted
    expect(store.get('cache:GET:localhost/test/1')).toBeUndefined();
  });

  it('should support CacheService for programmatic access', async () => {
    @Controller('/test')
    class TestController {
      constructor(private cacheService: CacheService) {}

      @Get('/set')
      setCache() {
        this.cacheService.set('manual', { data: 'test' });
        return { ok: true };
      }

      @Get('/get')
      getCache() {
        return this.cacheService.get('manual') ?? { data: 'not found' };
      }
    }

    @Module({
      imports: [CacheModule.forRoot()],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/test/set');
    const res = await hono.request('/test/get');
    expect(await res.json()).toEqual({ data: 'test' });
  });

  it('partitions anonymous cache entries by host and canonical query', async () => {
    let calls = 0;

    @Controller('/partitioned')
    class PartitionedController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get() {
        calls++;
        return { calls };
      }
    }

    @Module({ imports: [CacheModule.forRoot()], controllers: [PartitionedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect(await (await hono.request('https://a.test/partitioned?page=1&sort=asc')).json()).toEqual(
      {
        calls: 1,
      },
    );
    // Equivalent query ordering is one canonical entry.
    expect(await (await hono.request('https://a.test/partitioned?sort=asc&page=1')).json()).toEqual(
      {
        calls: 1,
      },
    );
    expect(await (await hono.request('https://a.test/partitioned?page=2&sort=asc')).json()).toEqual(
      {
        calls: 2,
      },
    );
    expect(await (await hono.request('https://b.test/partitioned?page=1&sort=asc')).json()).toEqual(
      {
        calls: 3,
      },
    );
  });

  it('bypasses shared caching for bearer and cookie credentials', async () => {
    let calls = 0;

    @Controller('/private')
    class PrivateController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get(@Headers('authorization') authorization?: string, @Headers('cookie') cookie?: string) {
        calls++;
        return { calls, authorization, cookie };
      }
    }

    @Module({ imports: [CacheModule.forRoot()], controllers: [PrivateController] })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    const a = await hono.request('/private', { headers: { authorization: 'Bearer user-a' } });
    const b = await hono.request('/private', { headers: { authorization: 'Bearer user-b' } });
    const cookie = await hono.request('/private', { headers: { cookie: 'session=user-c' } });

    expect(await a.json()).toEqual({ calls: 1, authorization: 'Bearer user-a' });
    expect(await b.json()).toEqual({ calls: 2, authorization: 'Bearer user-b' });
    expect(await cookie.json()).toEqual({ calls: 3, cookie: 'session=user-c' });
  });

  it('does not cache a plain handler result when the Hono context sets a cookie', async () => {
    let calls = 0;

    @Controller('/cookie-writer')
    class CookieWriterController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get(@Res() c: import('hono').Context) {
        calls++;
        c.header('Set-Cookie', `session=${calls}; HttpOnly; Secure`);
        return { calls };
      }
    }

    @Module({ imports: [CacheModule.forRoot()], controllers: [CookieWriterController] })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    expect(await (await hono.request('/cookie-writer')).json()).toEqual({ calls: 1 });
    expect(await (await hono.request('/cookie-writer')).json()).toEqual({ calls: 2 });
    expect(calls).toBe(2);
  });

  it('does not cache a Response carrying Set-Cookie', async () => {
    let calls = 0;

    @Controller('/cookie-response')
    class CookieResponseController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get() {
        calls++;
        return new Response(String(calls), {
          headers: { 'Set-Cookie': `session=${calls}; HttpOnly; Secure` },
        });
      }
    }

    @Module({ imports: [CacheModule.forRoot()], controllers: [CookieResponseController] })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    expect(await (await hono.request('/cookie-response')).text()).toBe('1');
    expect(await (await hono.request('/cookie-response')).text()).toBe('2');
    expect(calls).toBe(2);
  });

  it('partitions credentialed entries only through an explicit hashed variation', async () => {
    let calls = 0;
    const values = new Map<string, unknown>();
    const writtenKeys: string[] = [];
    const store = {
      get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
      set: <T>(key: string, value: T): void => {
        writtenKeys.push(key);
        values.set(key, value);
      },
      del: (key: string): void => void values.delete(key),
      clear: (): void => values.clear(),
    };

    @Controller('/private-varied')
    class PrivateController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get(@Headers('authorization') authorization?: string) {
        calls++;
        return { calls, authorization };
      }
    }

    @Module({
      imports: [
        CacheModule.forRoot({
          store,
          varyBy: (request) => {
            const authorization = request.headers.get('authorization');
            return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
          },
        }),
      ],
      controllers: [PrivateController],
    })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    const a1 = await hono.request('/private-varied', {
      headers: { authorization: 'Bearer user-a' },
    });
    const a2 = await hono.request('/private-varied', {
      headers: { authorization: 'Bearer user-a' },
    });
    const b = await hono.request('/private-varied', {
      headers: { authorization: 'Bearer user-b' },
    });

    expect(await a1.json()).toEqual({ calls: 1, authorization: 'Bearer user-a' });
    expect(await a2.json()).toEqual({ calls: 1, authorization: 'Bearer user-a' });
    expect(await b.json()).toEqual({ calls: 2, authorization: 'Bearer user-b' });
    expect(writtenKeys).toHaveLength(2);
    expect(writtenKeys.every((key) => !key.includes('user-a') && !key.includes('user-b'))).toBe(
      true,
    );
  });

  it('isolates authenticated cache entries by an explicit trusted tenant variation', async () => {
    let calls = 0;
    const values = new Map<string, unknown>();
    const writtenKeys: string[] = [];
    const tenantByToken = new Map([
      ['token-a', 'tenant-a'],
      ['token-b', 'tenant-b'],
    ]);
    const store = {
      get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
      set: <T>(key: string, value: T): void => {
        writtenKeys.push(key);
        values.set(key, value);
      },
      del: (key: string): void => void values.delete(key),
      clear: (): void => values.clear(),
    };
    const resolveTenant = (authorization: string | null): string | undefined => {
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      return token === undefined ? undefined : tenantByToken.get(token);
    };

    @Controller('/tenant-private')
    class TenantPrivateController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      @Cacheable()
      get(@Headers('authorization') authorization?: string) {
        calls += 1;
        return { calls, tenantId: resolveTenant(authorization ?? null) };
      }
    }

    @Module({
      imports: [
        CacheModule.forRoot({
          store,
          varyBy: (request) => {
            const tenantId = resolveTenant(request.headers.get('authorization'));
            return tenantId === undefined ? undefined : `tenant:${tenantId}`;
          },
        }),
      ],
      controllers: [TenantPrivateController],
    })
    class AppModule {}

    const hono = (await VelaFactory.create(AppModule)).getHonoApp();
    const tenantAFirst = await hono.request('/tenant-private', {
      headers: { authorization: 'Bearer token-a' },
    });
    const tenantBFirst = await hono.request('/tenant-private', {
      headers: { authorization: 'Bearer token-b' },
    });
    const tenantASecond = await hono.request('/tenant-private', {
      headers: { authorization: 'Bearer token-a' },
    });

    expect(await tenantAFirst.json()).toEqual({ calls: 1, tenantId: 'tenant-a' });
    expect(await tenantBFirst.json()).toEqual({ calls: 2, tenantId: 'tenant-b' });
    expect(await tenantASecond.json()).toEqual({ calls: 1, tenantId: 'tenant-a' });
    expect(writtenKeys).toHaveLength(2);
    expect(writtenKeys.every((key) => !key.includes('tenant-a') && !key.includes('tenant-b'))).toBe(
      true,
    );
  });
});
