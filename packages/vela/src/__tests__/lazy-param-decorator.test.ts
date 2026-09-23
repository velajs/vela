import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  REQUEST_CONTEXT,
  RequestContextKey,
  UseGuards,
  VelaFactory,
  createLazyParamDecorator,
  createParamDecorator,
} from '../index.js';
import type { CanActivate, ExecutionContext, Type } from '../index.js';

async function createApp(controller: Type, providers: Type[] = []) {
  @Module({ controllers: [controller], providers })
  class AppModule {}
  return (await VelaFactory.create(AppModule)).getHonoApp();
}

describe('custom parameter resolution', () => {
  it('runs guards before eager extraction and invokes lazy factories only on demand', async () => {
    const order: string[] = [];
    const lazyFactory = vi.fn((_data: undefined, _context: ExecutionContext) => {
      order.push('lazy');
      return 'value';
    });
    const Lazy = createLazyParamDecorator(lazyFactory);
    const Eager = createParamDecorator((_data: undefined, _context: ExecutionContext) => {
      order.push('eager');
      return 'eager value';
    });
    @Injectable()
    class Guard implements CanActivate {
      canActivate() {
        order.push('guard');
        return true;
      }
    }
    @Controller('/order')
    @UseGuards(Guard)
    class C {
      @Get()
      handle(@Eager() eager: string, @Lazy() load: () => string) {
        order.push('handler');
        expect(eager).toBe('eager value');
        expect(lazyFactory).not.toHaveBeenCalled();
        expect(load()).toBe('value');
        expect(load()).toBe('value');
        return { ok: true };
      }
    }
    const response = await (await createApp(C, [Guard])).request('/order');
    expect(response.status).toBe(200);
    expect(order).toEqual(['guard', 'eager', 'handler', 'lazy']);
  });

  it('does no extraction after a guard rejects the request', async () => {
    const factory = vi.fn(() => 'secret');
    const Lazy = createLazyParamDecorator(factory);
    const Eager = createParamDecorator(factory);
    @Injectable()
    class Guard implements CanActivate {
      canActivate() {
        return false;
      }
    }
    @Controller('/denied')
    @UseGuards(Guard)
    class C {
      @Get()
      handle(@Eager() _eager: unknown, @Lazy() _load: () => unknown) {
        throw new Error('Handler must not run');
      }
    }
    expect((await (await createApp(C, [Guard])).request('/denied')).status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not invoke a lazy factory when its parameter is unused', async () => {
    const factory = vi.fn(() => {
      throw new Error('Unused');
    });
    const Lazy = createLazyParamDecorator(factory);
    @Controller('/unused')
    class C {
      @Get()
      handle(@Lazy() _load: () => never) {
        return { ok: true };
      }
    }
    expect((await (await createApp(C)).request('/unused')).status).toBe(200);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, true, 0, 42, ''])(
    'preserves and caches the real value %s',
    async (value) => {
      const factory = vi.fn(() => value);
      const Lazy = createLazyParamDecorator(factory);
      @Controller('/value')
      class C {
        @Get()
        handle(@Lazy() load: () => unknown) {
          expect(load()).toBe(value);
          expect(load()).toBe(value);
          return { calls: factory.mock.calls.length };
        }
      }
      const response = await (await createApp(C)).request('/value');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ calls: 1 });
    },
  );

  it('returns the original object with its normal identity, properties and methods', async () => {
    const user = {
      name: 'curie',
      greet() {
        return `hello ${this.name}`;
      },
    };
    const Lazy = createLazyParamDecorator(() => user);
    @Controller('/object')
    class C {
      @Get()
      handle(@Lazy() load: () => typeof user) {
        const value = load();
        expect(value).toBe(user);
        expect(load()).toBe(value);
        expect(Object.keys(value)).toEqual(['name', 'greet']);
        return { greeting: value.greet(), serialized: JSON.stringify(value) };
      }
    }
    const response = await (await createApp(C)).request('/object');
    expect(await response.json()).toEqual({
      greeting: 'hello curie',
      serialized: '{"name":"curie"}',
    });
  });

  it('caches the original Promise, without extracting or awaiting its result early', async () => {
    const factory = vi.fn(async () => 'async value');
    const Lazy = createLazyParamDecorator(factory);
    @Controller('/promise')
    class C {
      @Get()
      async handle(@Lazy() load: () => Promise<string>) {
        expect(factory).not.toHaveBeenCalled();
        const first = load();
        expect(load()).toBe(first);
        return { value: await first, calls: factory.mock.calls.length };
      }
    }
    const response = await (await createApp(C)).request('/promise');
    expect(await response.json()).toEqual({ value: 'async value', calls: 1 });
  });

  it.each([new Error('failed'), undefined])(
    'caches a synchronous thrown value without retrying',
    async (error) => {
      const factory = vi.fn(() => {
        throw error;
      });
      const Lazy = createLazyParamDecorator(factory);
      @Controller('/failure')
      class C {
        @Get()
        handle(@Lazy() load: () => never) {
          for (let attempt = 0; attempt < 2; attempt++) {
            let didThrow = false;
            try {
              load();
            } catch (caught) {
              didThrow = true;
              expect(caught).toBe(error);
            }
            expect(didThrow).toBe(true);
          }
          return { calls: factory.mock.calls.length };
        }
      }
      const response = await (await createApp(C)).request('/failure');
      expect(await response.json()).toEqual({ calls: 1 });
    },
  );

  it('caches rejected promises without retrying or hiding their rejection', async () => {
    const error = new Error('async failure');
    const factory = vi.fn(async () => {
      throw error;
    });
    const Lazy = createLazyParamDecorator(factory);
    @Controller('/rejection')
    class C {
      @Get()
      async handle(@Lazy() load: () => Promise<never>) {
        const promise = load();
        await expect(promise).rejects.toBe(error);
        expect(load()).toBe(promise);
        await expect(load()).rejects.toBe(error);
        return { calls: factory.mock.calls.length };
      }
    }
    const response = await (await createApp(C)).request('/rejection');
    expect(await response.json()).toEqual({ calls: 1 });
  });

  it('passes required data through and propagates eager and lazy errors to exception handling', async () => {
    const factory = (data: string) => {
      throw new BadRequestException(data);
    };
    const Eager = createParamDecorator(factory);
    const Lazy = createLazyParamDecorator(factory);
    @Controller('/errors')
    class C {
      @Get('/eager')
      eager(@Eager('eager failure') _value: never) {
        throw new Error('Not reached');
      }
      @Get('/lazy')
      lazy(@Lazy('lazy failure') load: () => never) {
        return load();
      }
    }
    const app = await createApp(C);
    const eager = await app.request('/errors/eager');
    const lazy = await app.request('/errors/lazy');
    expect(eager.status).toBe(400);
    expect(lazy.status).toBe(400);
    expect(await eager.json()).toMatchObject({ error: { message: 'eager failure' } });
    expect(await lazy.json()).toMatchObject({ error: { message: 'lazy failure' } });
  });

  it('observes typed guard-populated request context', async () => {
    const USER = new RequestContextKey<{ id: string }>('test.user');
    @Injectable()
    class Guard implements CanActivate {
      canActivate(context: ExecutionContext) {
        const request = context.getContainer()?.resolve(REQUEST_CONTEXT);
        if (!request) throw new Error('Missing request context');
        request.set(USER, { id: 'u-from-guard' });
        return true;
      }
    }
    const CurrentUser = createLazyParamDecorator((_data: undefined, context: ExecutionContext) =>
      context.getContainer()?.resolve(REQUEST_CONTEXT).get(USER),
    );
    @Controller('/guard')
    @UseGuards(Guard)
    class C {
      @Get()
      handle(@CurrentUser() load: () => { id: string } | undefined) {
        return load();
      }
    }
    const response = await (await createApp(C, [Guard])).request('/guard');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'u-from-guard' });
  });

  it('rejects use on constructor parameters', () => {
    const Eager = createParamDecorator(() => undefined);
    const Lazy = createLazyParamDecorator(() => undefined);
    class C {}
    expect(() => Eager()(C, undefined, 0)).toThrow('method parameters');
    expect(() => Lazy()(C, undefined, 0)).toThrow('method parameters');
  });
});
