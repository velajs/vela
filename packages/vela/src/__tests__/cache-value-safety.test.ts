import { describe, expect, expectTypeOf, it } from 'vitest';
import { Controller, Get, Module, VelaFactory } from '../index';
import { Cacheable, CacheModule, CacheService, MemoryCacheStore, TieredCacheStore } from '../cache';

function parseCount(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('count' in value) ||
    typeof value.count !== 'number'
  ) {
    throw new TypeError('count must be a number');
  }
  return { count: value.count };
}

describe('cache value boundaries', () => {
  it('keeps raw reads unknown and infers parsed reads from a validating parser', () => {
    const store = new MemoryCacheStore();
    const cache = new CacheService(store);
    store.set('valid', { count: 3 });
    store.set('invalid', { count: 'untrusted JSON' });
    expectTypeOf(store.get('valid')).toEqualTypeOf<unknown>();
    expectTypeOf(cache.get('valid')).toEqualTypeOf<unknown>();
    expectTypeOf(cache.getParsed('valid', parseCount)).toEqualTypeOf<
      { count: number } | undefined
    >();
    expectTypeOf(new TieredCacheStore([store]).get('valid')).toEqualTypeOf<Promise<unknown>>();
    expect(cache.getParsed('valid', parseCount)).toEqual({ count: 3 });
    expect(cache.getParsed('missing', parseCount)).toBeUndefined();
    expect(() => cache.getParsed('invalid', parseCount)).toThrow('count must be a number');
    // @ts-expect-error persisted values cannot be typed by choosing a generic
    store.get<string>('valid');
    // @ts-expect-error callers must validate unknown cache values
    cache.get<{ count: number }>('valid');
  });

  it.each(['response', 'accessor', 'cycle', 'function'] as const)(
    'does not replay a cached %s as an HTTP response',
    async (kind) => {
      let getterCalls = 0;
      const invalid: object = {};
      if (kind === 'accessor')
        Object.defineProperty(invalid, 'secret', {
          enumerable: true,
          get: () => {
            getterCalls++;
            return 'secret';
          },
        });
      if (kind === 'cycle')
        Object.defineProperty(invalid, 'self', { enumerable: true, value: invalid });
      const cached =
        kind === 'response'
          ? new Response('private', { headers: { 'set-cookie': 'secret=1' } })
          : kind === 'function'
            ? () => 'private'
            : invalid;
      const store = new MemoryCacheStore();
      store.set('cache:GET:localhost/safe', cached);
      let calls = 0;
      @Controller('/safe')
      class SafeController {
        @Get()
        @Cacheable()
        read() {
          calls++;
          return { public: true };
        }
      }
      @Module({
        imports: [CacheModule.forRoot({ store, isGlobal: true })],
        controllers: [SafeController],
      })
      class App {}
      const app = await VelaFactory.create(App);
      const first = await app.getHonoApp().request('/safe');
      const second = await app.getHonoApp().request('/safe');
      expect(await first.json()).toEqual({ public: true });
      expect(await second.json()).toEqual({ public: true });
      expect(first.headers.has('set-cookie')).toBe(false);
      expect(calls).toBe(1);
      expect(getterCalls).toBe(0);
      await app.close();
    },
  );
});
