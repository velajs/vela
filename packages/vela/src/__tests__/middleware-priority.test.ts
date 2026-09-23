import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context, Next } from 'hono';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  Injectable,
  APP_MIDDLEWARE,
  MetadataRegistry,
  Scope,
} from '../index.js';
import type { NestMiddleware, NestModule, MiddlewareConsumer } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Middleware priority — consumer (.configure())', () => {
  it('preserves registration order when priorities are absent', async () => {
    const order: string[] = [];

    @Injectable()
    class FirstMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('first');
        await next();
      }
    }
    @Injectable()
    class SecondMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('second');
        await next();
      }
    }
    @Injectable()
    class ThirdMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('third');
        await next();
      }
    }

    @Controller('/order')
    class OrderController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [FirstMw, SecondMw, ThirdMw],
      controllers: [OrderController],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(FirstMw).forRoutes('*');
        consumer.apply(SecondMw).forRoutes('*');
        consumer.apply(ThirdMw).forRoutes('*');
      }
    }

    const app = await VelaFactory.create(AppModule);
    order.length = 0;
    await app.getHonoApp().request('/order');
    expect(order).toEqual(['first', 'second', 'third', 'handler']);
  });

  it('explicit priority runs earlier than default', async () => {
    const order: string[] = [];

    @Injectable()
    class DefaultMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('default');
        await next();
      }
    }
    @Injectable()
    class EarlyMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('early');
        await next();
      }
    }

    @Controller('/prio')
    class PrioController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [DefaultMw, EarlyMw],
      controllers: [PrioController],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        // Registered first; default priority.
        consumer.apply(DefaultMw).forRoutes('*');
        // Registered second with priority=-100; should still sort ahead.
        consumer.apply(EarlyMw).withPriority(-100).forRoutes('*');
      }
    }

    const app = await VelaFactory.create(AppModule);
    order.length = 0;
    await app.getHonoApp().request('/prio');
    expect(order).toEqual(['early', 'default', 'handler']);
  });

  it('stable sort: equal priorities keep registration order', async () => {
    const order: string[] = [];

    @Injectable()
    class A implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('a');
        await next();
      }
    }
    @Injectable()
    class B implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('b');
        await next();
      }
    }
    @Injectable()
    class C implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('c');
        await next();
      }
    }

    @Controller('/stable')
    class StableController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [A, B, C],
      controllers: [StableController],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(A).withPriority(10).forRoutes('*');
        consumer.apply(B).withPriority(10).forRoutes('*');
        consumer.apply(C).withPriority(10).forRoutes('*');
      }
    }

    const app = await VelaFactory.create(AppModule);
    order.length = 0;
    await app.getHonoApp().request('/stable');
    expect(order).toEqual(['a', 'b', 'c', 'handler']);
  });
});

describe('Middleware priority — APP_MIDDLEWARE (static priority)', () => {
  it('sorts APP_MIDDLEWARE providers by static priority on the class', async () => {
    const order: string[] = [];

    @Injectable()
    class DefaultMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('default');
        await next();
      }
    }

    @Injectable()
    class WrapperMw implements NestMiddleware {
      // Framework-internal wrappers can declare a static priority so they
      // sort outside user middleware regardless of registration order.
      static priority = Number.MIN_SAFE_INTEGER;
      async use(_c: Context, next: Next) {
        order.push('wrapper');
        await next();
      }
    }

    @Controller('/app-mw-prio')
    class AppMwController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [
        DefaultMw,
        WrapperMw,
        // DefaultMw registered BEFORE WrapperMw — registration order has
        // default coming first. Priority should force WrapperMw to the outside.
        defineProvider(APP_MIDDLEWARE, { useExisting: DefaultMw }),
        defineProvider(APP_MIDDLEWARE, { useExisting: WrapperMw }),
      ],
      controllers: [AppMwController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    order.length = 0;
    await app.getHonoApp().request('/app-mw-prio');
    expect(order).toEqual(['wrapper', 'default', 'handler']);
  });
});

describe('Middleware priority — request-scoped APP_MIDDLEWARE', () => {
  function orderedApp(order: string[], wrapper: 'useClass' | 'useExisting') {
    @Injectable()
    class DefaultMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('default');
        await next();
      }
    }

    // Request-scoped: the root container cannot construct it at route build.
    @Injectable({ scope: Scope.REQUEST })
    class RequestWrapperMw implements NestMiddleware {
      static priority = -10;
      async use(_c: Context, next: Next) {
        order.push('request-wrapper');
        await next();
      }
    }

    @Controller('/request-prio')
    class PriorityController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [
        DefaultMw,
        RequestWrapperMw,
        defineProvider(APP_MIDDLEWARE, { useExisting: DefaultMw }),
        wrapper === 'useClass'
          ? defineProvider(APP_MIDDLEWARE, { useClass: RequestWrapperMw })
          : defineProvider(APP_MIDDLEWARE, { useExisting: RequestWrapperMw }),
      ],
      controllers: [PriorityController],
    })
    class AppModule {}
    return AppModule;
  }

  it.each(['useClass', 'useExisting'] as const)(
    'reads the static priority of a %s target without constructing it',
    async (wrapper) => {
      const order: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const app = await VelaFactory.create(orderedApp(order, wrapper), { diagnostics: 'throw' });
      await app.getHonoApp().request('/request-prio');
      expect(order).toEqual(['request-wrapper', 'default', 'handler']);
      expect(warn).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('reports a request-scoped middleware without a static priority', async () => {
    const order: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class AuditMw implements NestMiddleware {
      readonly priority = -10;
      async use(_c: Context, next: Next) {
        order.push('audit');
        await next();
      }
    }

    @Injectable()
    class FirstMw implements NestMiddleware {
      async use(_c: Context, next: Next) {
        order.push('first');
        await next();
      }
    }

    @Controller('/request-default')
    class DefaultController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [
        defineProvider(APP_MIDDLEWARE, { useClass: FirstMw }),
        defineProvider(APP_MIDDLEWARE, { useClass: AuditMw }),
      ],
      controllers: [DefaultController],
    })
    class AppModule {}

    const message =
      '[vela] Middleware AuditMw is request-scoped and declares no static priority, so it ' +
      'sorts at priority 0 among global middleware. Declare `static priority` on the class ' +
      'to order it.';
    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(message);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await VelaFactory.create(AppModule);
    expect(warn).toHaveBeenCalledWith(message);
    await app.getHonoApp().request('/request-default');
    // The instance-level priority is invisible at build: registration order holds.
    expect(order).toEqual(['first', 'audit', 'handler']);
    await app.close();
  });
});
