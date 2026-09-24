import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import {
  All,
  Catch,
  Controller,
  Get,
  Head,
  Injectable,
  Inject,
  InjectionToken,
  Query,
  defineProvider,
  Module,
  Post,
  Req,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UseMiddleware,
  UsePipes,
  VelaFactory,
  type CallHandler,
  type ExecutionContext,
  type NestMiddleware,
} from '../index';

function traceMiddleware(trace: string[], name: string): NestMiddleware {
  return {
    async use(_context: Context, next: Next) {
      trace.push(`${name}:before`);
      await next();
      trace.push(`${name}:after`);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('scoped HTTP middleware dispatch', () => {
  it('runs only the matched method middleware and one controller onion on a shared path', async () => {
    const trace: string[] = [];
    @Controller('/shared')
    @UseMiddleware(traceMiddleware(trace, 'controller'))
    class Routes {
      @Get()
      @UseMiddleware(traceMiddleware(trace, 'get'))
      read() {
        trace.push('read');
        return 'get';
      }

      @Post()
      @UseMiddleware(traceMiddleware(trace, 'post'))
      write() {
        trace.push('write');
        return 'post';
      }
    }
    @Module({ controllers: [Routes] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const post = await app.getHonoApp().request('/shared', { method: 'POST' });
      expect(await post.text()).toBe('post');
      expect(trace).toEqual([
        'controller:before',
        'post:before',
        'write',
        'post:after',
        'controller:after',
      ]);
      trace.length = 0;
      await app.getHonoApp().request('/shared');
      expect(trace).toEqual([
        'controller:before',
        'get:before',
        'read',
        'get:after',
        'controller:after',
      ]);
    } finally {
      await app.close();
    }
  });

  it('does not run parameterized GET middleware on an overlapping POST route', async () => {
    const trace: string[] = [];
    @Controller('/items')
    class Routes {
      @Get('/:id')
      @UseMiddleware(traceMiddleware(trace, 'get'))
      read() {
        return 'get';
      }
      @Post('/create')
      create() {
        return 'post';
      }
    }
    @Module({ controllers: [Routes] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const response = await app.getHonoApp().request('/items/create', { method: 'POST' });
      expect(await response.text()).toBe('post');
      expect(trace).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('skips HEAD-only middleware for GET and preserves the HEAD response onion', async () => {
    const trace: string[] = [];
    @Controller('/head')
    class Routes {
      @Head()
      @UseMiddleware(traceMiddleware(trace, 'head'))
      head() {
        trace.push('head-handler');
        return new Response('hidden', { headers: { 'x-handler': 'head' } });
      }
      @Get()
      @UseMiddleware(traceMiddleware(trace, 'get'))
      get() {
        trace.push('get-handler');
        return 'get';
      }
    }
    @Module({ controllers: [Routes] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      expect(await (await app.getHonoApp().request('/head')).text()).toBe('get');
      expect(trace).toEqual(['get:before', 'get-handler', 'get:after']);
      trace.length = 0;
      const response = await app.getHonoApp().request('/head', { method: 'HEAD' });
      expect(response.headers.get('x-handler')).toBe('head');
      expect(await response.text()).toBe('');
      expect(trace).toEqual(['head:before', 'head-handler', 'head:after']);
    } finally {
      await app.close();
    }
  });

  it('retains GET fallback for HEAD and ALL middleware for every method', async () => {
    const trace: string[] = [];
    @Controller('/fallback')
    class Routes {
      @Get()
      @UseMiddleware(traceMiddleware(trace, 'get'))
      get() {
        return 'get';
      }
      @All('/all')
      @UseMiddleware(traceMiddleware(trace, 'all'))
      all() {
        return 'all';
      }
    }
    @Module({ controllers: [Routes] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const head = await app.getHonoApp().request('/fallback', { method: 'HEAD' });
      expect(await head.text()).toBe('');
      expect(trace).toEqual(['get:before', 'get:after']);
      for (const method of ['GET', 'POST', 'PATCH']) {
        trace.length = 0;
        expect(await (await app.getHonoApp().request('/fallback/all', { method })).text()).toBe(
          'all',
        );
        expect(trace).toEqual(['all:before', 'all:after']);
      }
    } finally {
      await app.close();
    }
  });
});

describe('HTTP construction boundary', () => {
  it('does not construct a request controller on guard rejection; allowed calls own separate instances', async () => {
    let constructed = 0;
    @Injectable()
    class LocalService {
      readonly value = 'module-local';
    }
    @Injectable({ scope: Scope.REQUEST })
    @Controller('/construction')
    class Routes {
      #id = ++constructed;
      constructor(private readonly service: LocalService) {}
      @Get()
      @UseGuards({
        canActivate(context: ExecutionContext) {
          return context.switchToHttp().getRequest().headers.has('allow');
        },
      })
      get() {
        return { id: this.#id, value: this.service.value };
      }
    }
    @Module({ controllers: [Routes], providers: [LocalService] })
    class Feature {}
    @Module({ imports: [Feature] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      expect(constructed).toBe(0);
      expect((await app.getHonoApp().request('/construction')).status).toBe(403);
      expect(constructed).toBe(0);
      for (const id of [1, 2]) {
        const response = await app
          .getHonoApp()
          .request('/construction', { headers: { allow: 'yes' } });
        expect(await response.json()).toEqual({ id, value: 'module-local' });
      }
    } finally {
      await app.close();
    }
  });

  it('preserves eager singleton lifecycle across rejected requests', async () => {
    const trace: string[] = [];
    @Controller('/singleton')
    class Routes {
      constructor() {
        trace.push('construct');
      }
      onModuleInit() {
        trace.push('init');
      }
      onApplicationShutdown() {
        trace.push('shutdown');
      }
      @Get()
      @UseGuards({
        canActivate() {
          return false;
        },
      })
      get() {
        throw new Error('unreachable');
      }
    }
    @Module({ controllers: [Routes] })
    class App {}
    const app = await VelaFactory.create(App);
    expect(trace).toEqual(['construct', 'init']);
    expect((await app.getHonoApp().request('/singleton')).status).toBe(403);
    expect(trace).toEqual(['construct', 'init']);
    await app.close();
    expect(trace).toEqual(['construct', 'init', 'shutdown']);
  });

  it.each(['guard', 'pipe', 'interceptor'] as const)(
    'reports %s construction failure before handler filters render it',
    async (kind) => {
      const trace: string[] = [];
      vi.spyOn(console, 'error').mockImplementation(() => {
        trace.push('report');
      });
      @Injectable({ scope: Scope.REQUEST })
      class BrokenComponent {
        constructor() {
          throw new Error(`${kind}-construction`);
        }
        canActivate() {
          return true;
        }
        transform(value: unknown) {
          return value;
        }
        intercept(_context: ExecutionContext, next: CallHandler) {
          return next.handle();
        }
      }
      @Catch()
      class Filter {
        catch(error: unknown) {
          trace.push('filter');
          return new Response(error instanceof Error ? error.message : 'unexpected', {
            status: 409,
          });
        }
      }
      @Controller('/broken')
      class Routes {
        @Get()
        @UseFilters(new Filter())
        get(@Req() _request: Request) {
          throw new Error('unreachable');
        }
      }
      ({ guard: UseGuards, pipe: UsePipes, interceptor: UseInterceptors })[kind](BrokenComponent)(
        Routes.prototype,
        'get',
      );
      @Module({ controllers: [Routes], providers: [BrokenComponent] })
      class App {}
      const app = await VelaFactory.create(App);
      try {
        const response = await app.getHonoApp().request('/broken');
        expect(response.status).toBe(409);
        expect(await response.text()).toBe(`${kind}-construction`);
        expect(trace).toEqual(['report', 'filter']);
      } finally {
        await app.close();
      }
    },
  );

  it('reports a filter construction failure without replacing or exposing the original error', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    @Injectable({ scope: Scope.REQUEST })
    @Catch()
    class BrokenFilter {
      constructor() {
        throw new Error('filter-secret');
      }
      catch() {
        return 'unreachable';
      }
    }
    @Controller('/filter')
    class Routes {
      @Get()
      @UseFilters(BrokenFilter)
      get() {
        throw new Error('handler-secret');
      }
    }
    @Module({ controllers: [Routes], providers: [BrokenFilter] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const response = await app.getHonoApp().request('/filter');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: 'internal', message: 'Internal Server Error' },
      });
      expect(report).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe('module-qualified async HTTP components', () => {
  it('uses each route owner for middleware, guards, parameter pipes, interceptors, filters and controllers', async () => {
    const OWNER = new InjectionToken<string>('owner');
    @Injectable()
    class Boundary {
      constructor(@Inject(OWNER) readonly owner: string) {}
      async use(context: Context, next: Next) {
        context.header('x-owner', this.owner);
        await next();
      }
      canActivate(context: ExecutionContext) {
        return new URL(context.switchToHttp().getRequest().url).pathname.startsWith(
          `/${this.owner}/`,
        );
      }
      transform(value: unknown) {
        return `${String(value)}:${this.owner}`;
      }
      async intercept(_context: ExecutionContext, next: CallHandler) {
        return { interceptor: this.owner, result: await next.handle() };
      }
      catch() {
        return Response.json({ filter: this.owner }, { status: 422 });
      }
    }
    function feature(owner: string) {
      @Controller(`/${owner}`)
      @UseMiddleware(Boundary)
      @UseGuards(Boundary)
      @UseInterceptors(Boundary)
      @UseFilters(Boundary)
      class Routes {
        constructor(@Inject(OWNER) readonly owner: string) {}
        @Get('/ok')
        get(@Query('value', Boundary) value: string) {
          return { controller: this.owner, value };
        }
        @Get('/error')
        error() {
          throw new Error('handled');
        }
      }
      @Module({
        controllers: [Routes],
        providers: [
          Boundary,
          defineProvider(OWNER, {
            scope: Scope.REQUEST,
            inject: [],
            useFactory: async () => owner,
          }),
        ],
      })
      class Feature {}
      return Feature;
    }
    @Module({ imports: [feature('a'), feature('b')] })
    class App {}
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await VelaFactory.create(App);
    try {
      for (const owner of ['b', 'a']) {
        const response = await app.getHonoApp().request(`/${owner}/ok?value=input`);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-owner')).toBe(owner);
        expect(await response.json()).toEqual({
          interceptor: owner,
          result: { controller: owner, value: `input:${owner}` },
        });
        const error = await app.getHonoApp().request(`/${owner}/error`);
        expect(error.status).toBe(422);
        expect(await error.json()).toEqual({ filter: owner });
      }
    } finally {
      await app.close();
    }
  });
});
