import { describe, it, expect } from 'vitest';
import { VelaFactory, Controller, Get, Module } from '../index.js';
import { CorsModule } from '../cors/index.js';
import { cors } from 'hono/cors';

describe('CorsModule', () => {
  it('should add CORS headers with wildcard origin', async () => {
    @Controller('/test')
    class TestController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({
      imports: [CorsModule.forRoot({ origin: '*' })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/test/hello', {
      headers: { Origin: 'http://example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('should handle specific origin', async () => {
    @Controller('/test')
    class TestController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({
      imports: [CorsModule.forRoot({ origin: 'http://allowed.com' })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/test/hello', {
      headers: { Origin: 'http://allowed.com' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://allowed.com');
  });

  it('should handle preflight OPTIONS requests', async () => {
    @Controller('/test')
    class TestController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({
      imports: [CorsModule.forRoot({ origin: '*', allowMethods: ['GET', 'POST'] })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/test/hello', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('should support credentials', async () => {
    @Controller('/test')
    class TestController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({
      imports: [CorsModule.forRoot({ origin: 'http://example.com', credentials: true })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/test/hello', {
      headers: { Origin: 'http://example.com' },
    });
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('should support enableCors() on application', async () => {
    @Controller('/test')
    class TestController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      middleware: [cors({ origin: '*' })],
    });

    const res = await app.getHonoApp().request('/test/hello', {
      headers: { Origin: 'http://example.com' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('should support custom headers', async () => {
    @Controller('/test')
    class TestController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({
      imports: [
        CorsModule.forRoot({
          origin: '*',
          exposeHeaders: ['X-Custom-Header'],
          allowHeaders: ['X-Requested-With'],
        }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/test/hello', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://example.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Requested-With',
      },
    });
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Requested-With');
  });
});
