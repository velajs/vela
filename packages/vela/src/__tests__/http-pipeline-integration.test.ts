import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import {
  APP_FILTER,
  APP_EXCEPTION_HANDLER,
  REQUEST_CONTEXT,
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Query,
  Scope,
  UsePipes,
  VelaFactory,
  defineProvider,
  type MiddlewareConsumer,
  type NestModule,
  type PipeTransform,
} from '../index';

afterEach(() => vi.restoreAllMocks());

describe('HTTP pipeline integration contracts', () => {
  it('prefers the explicit async pipe entry point once per global/scoped/parameter stage', async () => {
    const calls: string[] = [];
    function pipe(name: string): PipeTransform {
      return {
        transform() {
          throw new Error('speculative synchronous parse');
        },
        async transformAsync(value) {
          calls.push(name);
          return `${String(value)}:${name}`;
        },
      };
    }
    @Controller('/async-pipes')
    @UsePipes(pipe('scoped'))
    class Routes {
      @Get()
      get(@Query('value', pipe('parameter')) value: string) {
        return value;
      }
    }
    @Module({ controllers: [Routes] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(pipe('global'));
    try {
      const response = await app.getHonoApp().request('/async-pipes?value=input');
      expect(await response.text()).toBe('input:global:scoped:parameter');
      expect(calls).toEqual(['global', 'scoped', 'parameter']);
    } finally {
      await app.close();
    }
  });

  it('resolves configured middleware by owner with async dependencies and preserves short-circuit responses', async () => {
    const OWNER = new InjectionToken<string>('configured-owner');
    @Injectable()
    class Middleware {
      constructor(@Inject(OWNER) readonly owner: string) {}
      async use(context: Context, next: Next) {
        if (context.req.query('blocked')) return context.text(this.owner, 403);
        await next();
        context.header('x-owner', this.owner);
      }
    }
    function feature(owner: string) {
      @Controller(`/${owner}`)
      class Routes {
        @Get() get() {
          return owner;
        }
      }
      @Module({
        controllers: [Routes],
        providers: [
          Middleware,
          defineProvider(OWNER, {
            scope: Scope.REQUEST,
            inject: [],
            useFactory: async () => owner,
          }),
        ],
      })
      class Feature implements NestModule {
        configure(consumer: MiddlewareConsumer) {
          consumer.apply(Middleware).forRoutes(`/${owner}`);
        }
      }
      return Feature;
    }
    @Module({ imports: [feature('a'), feature('b')] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      for (const owner of ['b', 'a']) {
        const response = await app.getHonoApp().request(`/${owner}`);
        expect(await response.text()).toBe(owner);
        expect(response.headers.get('x-owner')).toBe(owner);
        const blocked = await app.getHonoApp().request(`/${owner}?blocked=1`);
        expect(blocked.status).toBe(403);
        expect(await blocked.text()).toBe(owner);
      }
    } finally {
      await app.close();
    }
  });

  it('reports middleware construction errors before an async global filter handles them', async () => {
    const order: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {
      order.push('report');
    });
    @Injectable({ scope: Scope.REQUEST })
    class BrokenMiddleware {
      constructor() {
        throw new Error('middleware-constructor');
      }
      async use(_context: Context, next: Next) {
        await next();
      }
    }
    @Catch()
    class Filter {
      catch() {
        order.push('filter');
        return new Response('handled', { status: 409 });
      }
    }
    @Controller('/error')
    class Routes {
      @Get() get() {
        return 'unreachable';
      }
    }
    @Module({
      controllers: [Routes],
      providers: [
        BrokenMiddleware,
        defineProvider(APP_FILTER, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: async () => new Filter(),
        }),
      ],
    })
    class App implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(BrokenMiddleware).forRoutes('/error');
      }
    }
    const app = await VelaFactory.create(App);
    try {
      const response = await app.getHonoApp().request('/error');
      expect(response.status).toBe(409);
      expect(await response.text()).toBe('handled');
      expect(order).toEqual(['report', 'filter']);
    } finally {
      await app.close();
    }
  });
});

it('reports raw Hono errors using the existing request container', async () => {
  const ids: string[] = [];
  @Module({
    providers: [
      defineProvider(APP_EXCEPTION_HANDLER, {
        scope: Scope.REQUEST,
        inject: [REQUEST_CONTEXT],
        useFactory: (request) => ({
          report() {
            ids.push(request.id);
          },
        }),
      }),
    ],
  })
  class App {}
  const app = await VelaFactory.create(App, {
    adapters: [
      {
        name: 'raw-error',
        onRoutesBuilt({ app }) {
          app.getHonoApp().get('/raw-error', () => {
            throw new Error('raw-secret');
          });
        },
      },
    ],
  });
  try {
    const response = await app
      .getHonoApp()
      .request('/raw-error', { headers: { 'x-request-id': 'correlation' } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'internal', message: 'Internal Server Error' },
    });
    expect(ids).toEqual(['correlation']);
  } finally {
    await app.close();
  }
});
