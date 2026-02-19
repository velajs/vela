import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  EdgestFactory,
  Controller,
  Get,
  Module,
  UseMiddleware,
  MetadataRegistry,
} from '../index.js';
import type { NestMiddleware } from '../index.js';
import type { Context, Next } from 'hono';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('Middleware', () => {
  it('should run controller-level middleware before the handler', async () => {
    const order: string[] = [];

    class LogMiddleware implements NestMiddleware {
      async use(c: Context, next: Next) {
        order.push('middleware-before');
        await next();
        order.push('middleware-after');
      }
    }

    @Controller('/mw')
    @UseMiddleware(new LogMiddleware())
    class MwController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({ controllers: [MwController] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/mw');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(order).toEqual(['middleware-before', 'handler', 'middleware-after']);
  });

  it('should run method-level middleware only on that route', async () => {
    const calls: string[] = [];

    class TrackMiddleware implements NestMiddleware {
      async use(_c: Context, next: Next) {
        calls.push('tracked');
        await next();
      }
    }

    @Controller('/routes')
    class RouteController {
      @Get('/with-mw')
      @UseMiddleware(new TrackMiddleware())
      withMiddleware() {
        return { mw: true };
      }

      @Get('/without-mw')
      withoutMiddleware() {
        return { mw: false };
      }
    }

    @Module({ controllers: [RouteController] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    calls.length = 0;
    await hono.request('/routes/without-mw');
    expect(calls.length).toBe(0);

    await hono.request('/routes/with-mw');
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe('tracked');
  });

  it('should support global middleware via app.useGlobalMiddleware()', async () => {
    const requestIds: string[] = [];

    class RequestIdMiddleware implements NestMiddleware {
      async use(c: Context, next: Next) {
        const id = 'req-' + Math.random().toString(36).slice(2, 8);
        c.set('requestId', id);
        requestIds.push(id);
        await next();
      }
    }

    @Controller('/global-mw')
    class GlobalMwController {
      @Get()
      handle() {
        return { ok: true };
      }

      @Get('/other')
      other() {
        return { other: true };
      }
    }

    @Module({ controllers: [GlobalMwController] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    app.useGlobalMiddleware(new RequestIdMiddleware());
    await app.rebuild();
    const hono = app.getHonoApp();

    await hono.request('/global-mw');
    await hono.request('/global-mw/other');

    expect(requestIds.length).toBe(2);
    expect(requestIds[0]).toMatch(/^req-/);
    expect(requestIds[1]).toMatch(/^req-/);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });

  it('should run middleware before guards in the pipeline', async () => {
    const order: string[] = [];

    class OrderMiddleware implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('middleware');
        await next();
      }
    }

    class OrderGuard {
      canActivate() {
        order.push('guard');
        return true;
      }
    }

    @Controller('/pipeline-order')
    @UseMiddleware(new OrderMiddleware())
    class PipelineOrderController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({ controllers: [PipelineOrderController] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    app.useGlobalGuards(new OrderGuard());
    const hono = app.getHonoApp();

    order.length = 0;
    await hono.request('/pipeline-order');
    expect(order).toEqual(['middleware', 'guard', 'handler']);
  });

  it('should support middleware that short-circuits (returns early)', async () => {
    class BlockMiddleware implements NestMiddleware {
      async use(c: Context, _next: Next) {
        return c.json({ blocked: true }, 403);
      }
    }

    @Controller('/blocked')
    @UseMiddleware(new BlockMiddleware())
    class BlockedController {
      @Get()
      handle() {
        return { should: 'not reach' };
      }
    }

    @Module({ controllers: [BlockedController] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/blocked');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ blocked: true });
  });

  it('should chain multiple middleware in order', async () => {
    const order: string[] = [];

    class FirstMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('first');
        await next();
      }
    }

    class SecondMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('second');
        await next();
      }
    }

    @Controller('/chain-mw')
    @UseMiddleware(new FirstMw(), new SecondMw())
    class ChainMwController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({ controllers: [ChainMwController] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    order.length = 0;
    await hono.request('/chain-mw');
    expect(order).toEqual(['first', 'second', 'handler']);
  });
});
