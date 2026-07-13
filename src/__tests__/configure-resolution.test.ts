import type { Context, Next } from 'hono';
import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Injectable, MetadataRegistry, Module, VelaFactory } from '../index.js';
import type { MiddlewareConsumer, NestModule } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// Regression coverage for audit #4: NestModule.configure() must (1) run with
// constructor-injected deps resolved through the container, and (2) propagate
// failures from configure() / DI to the caller — never silently skip middleware
// configuration.

describe('NestModule.configure() resolution', () => {
  it('resolves the module through the container so configure() can use injected deps', async () => {
    const log: string[] = [];

    @Injectable()
    class RouteRegistry {
      readonly paths = ['/alpha', '/beta'];
    }

    @Injectable()
    class TraceMiddleware {
      use(c: Context, next: Next) {
        log.push(c.req.path);
        return next();
      }
    }

    @Controller('/alpha')
    class AlphaController {
      @Get()
      handle() {
        return { ok: 'alpha' };
      }
    }

    @Controller('/beta')
    class BetaController {
      @Get()
      handle() {
        return { ok: 'beta' };
      }
    }

    @Module({
      providers: [RouteRegistry, TraceMiddleware],
      controllers: [AlphaController, BetaController],
    })
    class AppModule implements NestModule {
      constructor(private readonly registry: RouteRegistry) {}
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(TraceMiddleware).forRoutes(...this.registry.paths);
      }
    }

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    await hono.request('/alpha');
    await hono.request('/beta');

    expect(log).toEqual(['/alpha', '/beta']);
  });

  it('propagates errors thrown synchronously from configure()', async () => {
    @Module({})
    class BrokenModule implements NestModule {
      configure(_consumer: MiddlewareConsumer) {
        throw new Error('configure() exploded');
      }
    }

    await expect(VelaFactory.create(BrokenModule)).rejects.toThrow('configure() exploded');
  });

  it('propagates DI failures when the module has unresolvable constructor deps', async () => {
    class External {}

    @Module({})
    class NeedyModule implements NestModule {
      constructor(private readonly external: External) {}
      configure(_consumer: MiddlewareConsumer) {
        // Should never run — DI fails first.
        void this.external;
      }
    }

    // Module visibility rejects unknown class tokens with a clear error rather
    // than silently skipping configure().
    await expect(VelaFactory.create(NeedyModule)).rejects.toThrow();
  });
});
