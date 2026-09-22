import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Context, Next } from 'hono';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  Injectable,
  UseFilters,
  UseMiddleware,
  Catch,
  HttpException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  APP_FILTER,
  MetadataRegistry,
} from '../index.js';
import type {
  ExceptionFilter,
  ExecutionContext,
  NestMiddleware,
  NestModule,
  MiddlewareConsumer,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// Item 1.6.0/A — exception-filter chain catches errors from middlewares
// =============================================================================

describe('Middleware exception filter coverage', () => {
  it('catches an error thrown from a module-level middleware via APP_FILTER', async () => {
    @Catch()
    class CatchAllFilter implements ExceptionFilter {
      catch(exception: unknown, _ctx: ExecutionContext) {
        const message = exception instanceof Error ? exception.message : 'unknown';
        const status = exception instanceof HttpException ? exception.getStatus() : 500;
        return { caught: true, message, status };
      }
    }

    @Injectable()
    class ThrowingMw implements NestMiddleware {
      async use(_c: Context, _next: Next) {
        throw new BadRequestException('blocked-in-middleware');
      }
    }

    @Controller('/m1')
    class M1Controller {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [M1Controller],
      providers: [ThrowingMw, defineProvider(APP_FILTER, { useClass: CatchAllFilter })],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(ThrowingMw).forRoutes('/m1');
      }
    }

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/m1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      caught: true,
      message: 'blocked-in-middleware',
      status: 400,
    });
  });

  it('catches an error thrown from a global middleware via APP_FILTER', async () => {
    @Catch()
    class CatchAllFilter implements ExceptionFilter {
      catch(exception: unknown, _ctx: ExecutionContext) {
        const status = exception instanceof HttpException ? exception.getStatus() : 500;
        return { caught: 'global', status };
      }
    }

    @Controller('/g1')
    class G1Controller {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [G1Controller],
      providers: [defineProvider(APP_FILTER, { useClass: CatchAllFilter })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      middleware: [
        async (_c: Context, _next: Next) => {
          throw new ForbiddenException('global-throw');
        },
      ],
    });

    const res = await app.getHonoApp().request('/g1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caught: 'global', status: 403 });
  });

  it('catches an error thrown from a per-route attached middleware via APP_FILTER', async () => {
    @Catch()
    class PerRouteFilter implements ExceptionFilter {
      catch(_exception: unknown, _ctx: ExecutionContext) {
        return { caught: 'per-route' };
      }
    }

    @Injectable()
    class ThrowingMw implements NestMiddleware {
      async use(_c: Context, _next: Next) {
        throw new NotFoundException('per-route');
      }
    }

    @Controller('/r1')
    class R1Controller {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [R1Controller],
      providers: [ThrowingMw, defineProvider(APP_FILTER, { useClass: PerRouteFilter })],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(ThrowingMw).forRoutes({ path: '/r1' });
      }
    }

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/r1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caught: 'per-route' });
  });

  it('respects @Catch type matching when filtering middleware errors', async () => {
    @Catch(NotFoundException)
    class NotFoundOnlyFilter implements ExceptionFilter<NotFoundException> {
      catch(exception: NotFoundException, _ctx: ExecutionContext) {
        return { caught: 'not-found-only', message: exception.message };
      }
    }

    @Injectable()
    class ThrowingMw implements NestMiddleware {
      async use(c: Context, _next: Next) {
        const which = c.req.query('which');
        if (which === 'nf') throw new NotFoundException('mw-nf');
        throw new ForbiddenException('mw-fb');
      }
    }

    @Controller('/typed')
    class TypedController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [TypedController],
      providers: [ThrowingMw, defineProvider(APP_FILTER, { useClass: NotFoundOnlyFilter })],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(ThrowingMw).forRoutes('/typed');
      }
    }

    const app = await VelaFactory.create(AppModule);

    // NotFoundException — caught by typed filter.
    const matched = await app.getHonoApp().request('/typed?which=nf');
    expect(matched.status).toBe(200);
    expect(await matched.json()).toEqual({ caught: 'not-found-only', message: 'mw-nf' });

    // ForbiddenException — not in @Catch types, falls through to the canonical
    // HttpException body (NestJS-parity: status from getStatus()).
    const skipped = await app.getHonoApp().request('/typed?which=fb');
    expect(skipped.status).toBe(403);
    expect(await skipped.json()).toEqual({ error: { code: 'forbidden', message: 'mw-fb' } });
  });

  it('returns the HttpException default response when no APP_FILTER is registered', async () => {
    @Injectable()
    class ThrowingMw implements NestMiddleware {
      async use(_c: Context, _next: Next) {
        throw new BadRequestException('no-filter');
      }
    }

    @Controller('/no-filter')
    class NoFilterController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [NoFilterController],
      providers: [ThrowingMw],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(ThrowingMw).forRoutes('/no-filter');
      }
    }

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/no-filter');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'bad_request', message: 'no-filter' } });
  });

  it('regression: a per-route middleware that returns a Response short-circuits without invoking filters', async () => {
    let filterCalls = 0;

    @Catch()
    class TrackingFilter implements ExceptionFilter {
      catch(_e: unknown, _ctx: ExecutionContext) {
        filterCalls += 1;
        return { caught: true };
      }
    }

    class ShortCircuitMw implements NestMiddleware {
      async use(c: Context, _next: Next) {
        return c.json({ blocked: true }, 403);
      }
    }

    @Controller('/sc')
    @UseMiddleware(new ShortCircuitMw())
    class ScController {
      @Get()
      handle() {
        return { unreachable: true };
      }
    }

    @Module({
      controllers: [ScController],
      providers: [defineProvider(APP_FILTER, { useClass: TrackingFilter })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/sc');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ blocked: true });
    expect(filterCalls).toBe(0);
  });

  it('regression: a middleware that calls await next() proceeds to the handler unchanged', async () => {
    const trace: string[] = [];

    @Injectable()
    class TraceMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        trace.push('before');
        await next();
        trace.push('after');
      }
    }

    @Controller('/proceed')
    class ProceedController {
      @Get()
      handle() {
        trace.push('handler');
        return { ok: true };
      }
    }

    @Module({
      controllers: [ProceedController],
      providers: [TraceMw],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(TraceMw).forRoutes('/proceed');
      }
    }

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/proceed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(trace).toEqual(['before', 'handler', 'after']);
  });

  it('handler-level @UseFilters still wins for handler-thrown errors (no precedence change)', async () => {
    @Catch()
    class GlobalFilter implements ExceptionFilter {
      catch(_e: unknown, _ctx: ExecutionContext) {
        return { level: 'global' };
      }
    }

    @Catch()
    class HandlerFilter implements ExceptionFilter {
      catch(_e: unknown, _ctx: ExecutionContext) {
        return { level: 'handler' };
      }
    }

    @Controller('/precedence')
    class PrecedenceController {
      @Get()
      @UseFilters(new HandlerFilter())
      handle() {
        throw new BadRequestException('boom');
      }
    }

    @Module({
      controllers: [PrecedenceController],
      providers: [defineProvider(APP_FILTER, { useClass: GlobalFilter })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/precedence');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ level: 'handler' });
  });

  it('catches an error thrown after await next() (post-handler error path)', async () => {
    @Catch()
    class PostFilter implements ExceptionFilter {
      catch(exception: unknown, _ctx: ExecutionContext) {
        const message = exception instanceof Error ? exception.message : 'unknown';
        return { caught: 'post', message };
      }
    }

    @Injectable()
    class PostThrowMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        await next();
        throw new BadRequestException('post-handler');
      }
    }

    @Controller('/post')
    class PostController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [PostController],
      providers: [PostThrowMw, defineProvider(APP_FILTER, { useClass: PostFilter })],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(PostThrowMw).forRoutes('/post');
      }
    }

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/post');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caught: 'post', message: 'post-handler' });
  });

  it('catches a synchronously-thrown error from a middleware', async () => {
    @Catch()
    class SyncFilter implements ExceptionFilter {
      catch(exception: unknown, _ctx: ExecutionContext) {
        const message = exception instanceof Error ? exception.message : 'unknown';
        return { caught: 'sync', message };
      }
    }

    @Injectable()
    class SyncThrowMw implements NestMiddleware {
      // Synchronous throw inside an async signature — exercises the
      // "throws before any await" branch of the wrapper.
      use(_c: Context, _next: Next): Promise<Response | void> {
        throw new BadRequestException('sync-throw');
      }
    }

    @Controller('/sync')
    class SyncController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [SyncController],
      providers: [SyncThrowMw, defineProvider(APP_FILTER, { useClass: SyncFilter })],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(SyncThrowMw).forRoutes('/sync');
      }
    }

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/sync');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caught: 'sync', message: 'sync-throw' });
  });
});
