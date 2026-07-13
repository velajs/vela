import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  REQUEST_CONTEXT,
  Scope,
  UseGuards,
  createLazyParamDecorator,
  createParamDecorator,
  MetadataRegistry,
} from '../index.js';
import type { CanActivate, ExecutionContext, RequestContext } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

const USER_KEY = Symbol.for('test.user');

interface User {
  id: string;
  name: string;
  greet(): string;
}

// =============================================================================
// Item 1.6.0/B — createLazyParamDecorator helper
// =============================================================================

describe('createLazyParamDecorator', () => {
  it('does NOT run the factory during argument extraction (before guards)', async () => {
    const factorySpy = vi.fn((_data: unknown, _ctx: ExecutionContext) => ({ id: 'noop' }));
    const Lazy = createLazyParamDecorator(factorySpy);

    @Injectable({ scope: Scope.REQUEST })
    class GuardThatRunsAfterArgs implements CanActivate {
      canActivate(_e: ExecutionContext): boolean {
        // By the time the guard runs, args are already extracted. If the
        // lazy factory had fired during extraction, this assertion fails
        // — proving the deferral is necessary.
        expect(factorySpy).not.toHaveBeenCalled();
        return true;
      }
    }

    @Controller('/lazy-deferred')
    @UseGuards(GuardThatRunsAfterArgs)
    class LazyDeferredController {
      @Get()
      handle(@Lazy() _value: unknown) {
        return { ok: true };
      }
    }

    @Module({
      providers: [GuardThatRunsAfterArgs],
      controllers: [LazyDeferredController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/lazy-deferred');
    expect(res.status).toBe(200);
    // Handler did not touch the value either, so factory never fired.
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('runs the factory the first time a property is read on the resolved value', async () => {
    const factorySpy = vi.fn(
      (_data: unknown, _ctx: ExecutionContext): User => ({
        id: 'u-1',
        name: 'ada',
        greet() {
          return `hi ${this.name}`;
        },
      }),
    );
    const Lazy = createLazyParamDecorator(factorySpy);

    @Controller('/lazy-access')
    class C {
      @Get()
      handle(@Lazy() user: User) {
        // First property access — factory must fire here, not before.
        const id = user.id;
        return { id, callCount: factorySpy.mock.calls.length };
      }
    }

    @Module({ controllers: [C] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/lazy-access');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'u-1', callCount: 1 });
  });

  it('await on the proxy does NOT trigger the factory (then-trap escape)', async () => {
    const factorySpy = vi.fn((_d: unknown, _c: ExecutionContext) => ({ id: 'x' }));
    const Lazy = createLazyParamDecorator(factorySpy);

    @Controller('/lazy-await')
    class C {
      @Get()
      async handle(@Lazy() value: { id: string }) {
        // `await value` must return the proxy itself (not call the factory).
        const awaited = await (value as unknown as Promise<{ id: string }>);
        const callsAfterAwait = factorySpy.mock.calls.length;
        const id = (awaited as { id: string }).id; // first real access
        return { id, callsAfterAwait, callsAfterAccess: factorySpy.mock.calls.length };
      }
    }

    @Module({ controllers: [C] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/lazy-await');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'x', callsAfterAwait: 0, callsAfterAccess: 1 });
  });

  it('JSON.stringify works after one access (ownKeys + getOwnPropertyDescriptor)', async () => {
    const Lazy = createLazyParamDecorator((_d: unknown, _c: ExecutionContext) => ({
      id: 'u-2',
      role: 'admin',
    }));

    @Controller('/lazy-json')
    class C {
      @Get()
      handle(@Lazy() user: { id: string; role: string }) {
        // Touch once to materialize, then stringify.
        void user.id;
        return { serialized: JSON.stringify(user) };
      }
    }

    @Module({ controllers: [C] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/lazy-json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serialized: string };
    expect(JSON.parse(body.serialized)).toEqual({ id: 'u-2', role: 'admin' });
  });

  it('binds method results so `this` works on the resolved real target', async () => {
    const Lazy = createLazyParamDecorator((_d: unknown, _c: ExecutionContext) => ({
      name: 'curie',
      greet() {
        return `hello ${this.name}`;
      },
    }));

    @Controller('/lazy-this')
    class C {
      @Get()
      handle(@Lazy() user: { name: string; greet(): string }) {
        // Detach the method — without `this`-binding the call would
        // either throw or read the wrong `name`.
        const greet = user.greet;
        return { msg: greet() };
      }
    }

    @Module({ controllers: [C] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/lazy-this');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: 'hello curie' });
  });

  it('observes guard-populated state via REQUEST_CONTEXT (the ordering hazard fix)', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class PopulatingGuard implements CanActivate {
      constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext) {}
      canActivate(_e: ExecutionContext): boolean {
        const user: User = {
          id: 'u-from-guard',
          name: 'lovelace',
          greet() {
            return `hello ${this.name}`;
          },
        };
        this.ctx.set(USER_KEY, user);
        return true;
      }
    }

    const CurrentUser = createLazyParamDecorator(
      (_data: unknown, ctx: ExecutionContext): User | undefined => {
        const hono = ctx.getContext();
        const requestContainer = hono.get('container') as { resolve<T>(t: unknown): T } | undefined;
        if (!requestContainer) return undefined;
        const reqCtx = requestContainer.resolve<RequestContext>(REQUEST_CONTEXT);
        return reqCtx.get<User>(USER_KEY);
      },
    );

    @Controller('/lazy-guard')
    @UseGuards(PopulatingGuard)
    class C {
      @Get()
      handle(@CurrentUser() user: User) {
        return { id: user.id, msg: user.greet() };
      }
    }

    @Module({
      providers: [PopulatingGuard],
      controllers: [C],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/lazy-guard');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'u-from-guard', msg: 'hello lovelace' });
  });

  it('regression: a non-lazy createParamDecorator fires before guards (documents the hazard)', async () => {
    const order: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class LateGuard implements CanActivate {
      canActivate(_e: ExecutionContext): boolean {
        order.push('guard');
        return true;
      }
    }

    const Eager = createParamDecorator((_data: unknown, _ctx: ExecutionContext) => {
      order.push('decorator-factory');
      return { sentinel: true };
    });

    @Controller('/eager-order')
    @UseGuards(LateGuard)
    class C {
      @Get()
      handle(@Eager() value: { sentinel: boolean }) {
        order.push('handler');
        return { value };
      }
    }

    @Module({
      providers: [LateGuard],
      controllers: [C],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    order.length = 0;
    const res = await app.getHonoApp().request('/eager-order');
    expect(res.status).toBe(200);
    // Eager decorator factory runs during arg extraction — before guards.
    expect(order).toEqual(['decorator-factory', 'guard', 'handler']);
  });
});
