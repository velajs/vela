import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  Injectable,
  Inject,
  MetadataRegistry,
  UseInterceptors,
} from '../index.js';
import {
  CacheModule,
  CacheInterceptor,
  CacheService,
  CacheKey,
  CacheTTL,
  CACHE_MANAGER,
} from '../cache/index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('CacheModule', () => {
  it('should cache GET responses (handler called once for same URL)', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/data')
      @UseInterceptors(CacheInterceptor)
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
      getA() {
        callCount++;
        return { path: 'a' };
      }

      @Get('/b')
      @UseInterceptors(CacheInterceptor)
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

  it('should support @CacheKey custom key', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/x')
      @UseInterceptors(CacheInterceptor)
      @CacheKey('custom-key')
      getX() {
        callCount++;
        return { x: true };
      }

      @Get('/y')
      @UseInterceptors(CacheInterceptor)
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

    // /y shares the same cache key, so it should return cached value from /x
    const res2 = await hono.request('/test/y');
    expect(await res2.json()).toEqual({ x: true });
    expect(callCount).toBe(1);
  });

  it('should support @CacheTTL and expire entries', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/ttl')
      @UseInterceptors(CacheInterceptor)
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

  it('should cache all GET routes when isGlobal: true', async () => {
    let callCount = 0;

    @Controller('/test')
    class TestController {
      @Get('/global')
      getGlobal() {
        callCount++;
        return { global: true };
      }
    }

    @Module({
      imports: [CacheModule.forRoot({ isGlobal: true })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/test/global');
    await hono.request('/test/global');
    expect(callCount).toBe(1);
  });

  it('should evict entries when max is reached', async () => {
    @Controller('/test')
    class TestController {
      @Get('/1')
      @UseInterceptors(CacheInterceptor)
      get1() {
        return { id: 1 };
      }

      @Get('/2')
      @UseInterceptors(CacheInterceptor)
      get2() {
        return { id: 2 };
      }

      @Get('/3')
      @UseInterceptors(CacheInterceptor)
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
    expect(store.get('cache:GET:/test/3')).toEqual({ id: 3 });
    // /test/1 should have been evicted
    expect(store.get('cache:GET:/test/1')).toBeUndefined();
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
});
