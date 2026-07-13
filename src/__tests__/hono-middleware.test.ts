import { describe, it, expect, beforeEach } from 'vitest';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from 'hono/request-id';
import { etag } from 'hono/etag';
import { bodyLimit } from 'hono/body-limit';
import { VelaFactory, Controller, Get, Post, Module, MetadataRegistry } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

@Controller('/test')
class TestController {
  @Get('/hello')
  hello() {
    return { message: 'hello' };
  }

  @Get('/body')
  async body() {
    return { ok: true };
  }
}

@Module({ controllers: [TestController] })
class AppModule {}

describe('VelaApplication Hono middleware methods', () => {
  it('enableSecureHeaders() adds security headers', async () => {
    MetadataRegistry.clear();

    @Controller('/sec')
    class SecController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [SecController] })
    class SecModule {}

    const app = await VelaFactory.create(SecModule, {
      middleware: [secureHeaders()],
    });

    const res = await app.getHonoApp().request('/sec/hello');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeTruthy();
    expect(res.headers.get('x-content-type-options')).toBeTruthy();
  });

  it('enableBodyLimit() returns 413 for oversized body', async () => {
    MetadataRegistry.clear();

    @Controller('/limit')
    class LimitController {
      @Post('/upload')
      upload() {
        return { ok: true };
      }
    }

    @Module({ controllers: [LimitController] })
    class LimitModule {}

    const app = await VelaFactory.create(LimitModule, {
      middleware: [bodyLimit({ maxSize: 10 })],
    });

    const bigBody = 'x'.repeat(100);
    const res = await app.getHonoApp().request('/limit/upload', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': String(bigBody.length) },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });

  it('enableLogger() does not throw and middleware chain continues', async () => {
    MetadataRegistry.clear();

    @Controller('/log')
    class LogController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [LogController] })
    class LogModule {}

    const logs: string[] = [];
    const app = await VelaFactory.create(LogModule, {
      middleware: [logger((str) => logs.push(str))],
    });

    const res = await app.getHonoApp().request('/log/hello');
    expect(res.status).toBe(200);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('enableRequestId() adds x-request-id header', async () => {
    MetadataRegistry.clear();

    @Controller('/rid')
    class RidController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [RidController] })
    class RidModule {}

    const app = await VelaFactory.create(RidModule, {
      middleware: [requestId()],
    });

    const res = await app.getHonoApp().request('/rid/hello');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('enableEtag() adds etag header', async () => {
    MetadataRegistry.clear();

    @Controller('/etag')
    class EtagController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [EtagController] })
    class EtagModule {}

    const app = await VelaFactory.create(EtagModule, {
      middleware: [etag()],
    });

    const res = await app.getHonoApp().request('/etag/hello');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('enableEtag() returns 304 on repeat request with If-None-Match', async () => {
    MetadataRegistry.clear();

    @Controller('/etag2')
    class Etag2Controller {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [Etag2Controller] })
    class Etag2Module {}

    const app = await VelaFactory.create(Etag2Module, {
      middleware: [etag()],
    });

    const first = await app.getHonoApp().request('/etag2/hello');
    const etagValue = first.headers.get('etag');
    expect(etagValue).toBeTruthy();

    const second = await app.getHonoApp().request('/etag2/hello', {
      headers: { 'If-None-Match': etagValue! },
    });
    expect(second.status).toBe(304);
  });

  it('useRawMiddleware() applies arbitrary Hono middleware', async () => {
    MetadataRegistry.clear();

    @Controller('/raw')
    class RawController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [RawController] })
    class RawModule {}

    const app = await VelaFactory.create(RawModule, {
      middleware: [
        async (c, next) => {
          await next();
          c.res = new Response(c.res.body, {
            status: c.res.status,
            headers: { ...Object.fromEntries(c.res.headers), 'x-custom': 'injected' },
          });
        },
      ],
    });

    const res = await app.getHonoApp().request('/raw/hello');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-custom')).toBe('injected');
  });

  it('factory middleware option applies without rebuild()', async () => {
    MetadataRegistry.clear();

    @Controller('/factory')
    class FactoryController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [FactoryController] })
    class FactoryModule {}

    const logs: string[] = [];
    const app = await VelaFactory.create(FactoryModule, {
      middleware: [logger((str) => logs.push(str)), secureHeaders(), requestId()],
    });

    // No rebuild() needed
    const res = await app.getHonoApp().request('/factory/hello');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(logs.length).toBeGreaterThan(0);
  });

  it('multiple middleware applied via factory options all work', async () => {
    MetadataRegistry.clear();

    @Controller('/chain')
    class ChainController {
      @Get('/hello')
      hello() {
        return { message: 'hello' };
      }
    }

    @Module({ controllers: [ChainController] })
    class ChainModule {}

    const logs: string[] = [];
    const app = await VelaFactory.create(ChainModule, {
      middleware: [logger((str) => logs.push(str)), requestId(), secureHeaders()],
    });

    const res = await app.getHonoApp().request('/chain/hello');
    expect(res.status).toBe(200);
  });
});
