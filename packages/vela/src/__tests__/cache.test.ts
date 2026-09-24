import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  Controller,
  Get,
  Post,
  Res,
  Headers,
  Header,
  HttpCode,
  Module,
  UseGuards,
  VelaFactory,
  type ErrorReportContext,
  type ExecutionContext,
  type Type,
  type VelaEnv,
} from '../index';
import {
  CacheModule,
  CacheResponse,
  CacheService,
  MemoryCacheStore,
  MemoryCacheInvalidationStore,
  type CacheInvalidationStore,
  type CacheModuleOptions,
  type CacheScope,
  type CacheStore,
} from '../cache/index';
import { setTrustedRequestIdentity } from '../module-kit';

class AsyncStore implements CacheStore {
  readonly values = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async del(key: string): Promise<void> {
    this.values.delete(key);
  }
  async clear(): Promise<void> {
    this.values.clear();
  }
}
const publicScope = { visibility: 'public', partition: 'catalog' } as const;
const privateScope = (tenant: string, actor: string): CacheScope => ({
  visibility: 'private',
  partition: JSON.stringify([tenant, actor]),
});
const createService = (
  store = new AsyncStore(),
  invalidation: CacheInvalidationStore | undefined = new MemoryCacheInvalidationStore(),
) => new CacheService({ namespace: 'test', store, scope: () => publicScope, invalidation });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
afterEach(() => vi.useRealTimers());

describe('scoped asynchronous cache', () => {
  it('round trips, validates parsed reads, snapshots values and scopes keys/tags/all invalidation', async () => {
    const store = new AsyncStore();
    const service = createService(store);
    const a = service.scope(privateScope('one', 'a'));
    const b = service.scope(privateScope('one', 'b'));
    const c = service.scope(privateScope('two', 'a'));
    const value = { count: 1 };
    for (const cache of [a, b, c])
      expect(await cache.set('same', value, { tags: ['items'] })).toBe(true);
    value.count = 2;
    expect(await a.get('same')).toEqual({ count: 1 });
    expect(
      await a.getParsed('same', (value) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('count' in value) ||
          typeof value.count !== 'number'
        )
          throw Error('invalid');
        return value.count;
      }),
    ).toBe(1);
    expect(await a.invalidateTags(['items'])).toEqual({ ok: true });
    expect(await a.get('same')).toBeUndefined();
    expect(await b.get('same')).toEqual({ count: 1 });
    expect(await c.get('same')).toEqual({ count: 1 });
    await b.invalidateKey('same');
    expect(await b.get('same')).toBeUndefined();
    expect(await c.get('same')).toEqual({ count: 1 });
    await c.invalidateAll();
    expect(await c.get('same')).toBeUndefined();
    expect(
      [...store.values.keys()].every((key) => !key.includes('one') && !key.includes('items')),
    ).toBe(true);
  });

  it('does not extend logical TTL even with a backing store that retains values', async () => {
    vi.useFakeTimers();
    const cache = createService().scope(publicScope);
    await cache.set('short', { count: 1 }, { ttl: 0.05 });
    expect(await cache.get('short')).toEqual({ count: 1 });
    vi.advanceTimersByTime(50);
    expect(await cache.get('short')).toBeUndefined();
    expect(await cache.set('zero', 1, { ttl: 0 })).toBe(false);
  });

  it('does not resurrect a slow fill after tag, key or whole-scope invalidation', async () => {
    for (const operation of ['tags', 'key', 'all'] as const) {
      const cache = createService().scope(publicScope);
      const started = deferred<void>();
      const release = deferred<number>();
      const fill = cache.remember(
        'key',
        async () => {
          started.resolve();
          return release.promise;
        },
        { tags: ['items'] },
      );
      await started.promise;
      if (operation === 'tags') await cache.invalidateTags(['items']);
      if (operation === 'key') await cache.invalidateKey('key');
      if (operation === 'all') await cache.invalidateAll();
      await cache.set('key', 2, { tags: ['items'] });
      release.resolve(1);
      expect(await fill).toBe(1); // The already-running read may finish with its original result.
      expect(await cache.get('key')).toBe(2);
    }
  });

  it('rejects a late physical write completed after invalidation', async () => {
    const store = new AsyncStore();
    const started = deferred<void>();
    const release = deferred<void>();
    const originalSet = store.set.bind(store);
    store.set = async (key, value) => {
      started.resolve();
      await release.promise;
      await originalSet(key, value);
    };
    const cache = createService(store).scope(publicScope);
    const fill = cache.remember('late', async () => 1, { tags: ['items'] });
    await started.promise;
    await cache.invalidateTags(['items']);
    release.resolve();
    expect(await fill).toBe(1);
    expect(await cache.get('late')).toBeUndefined();
  });

  it('handles concurrent misses independently without sharing mutable handler results', async () => {
    const cache = createService().scope(publicScope);
    const loader = vi.fn(async () => ({ count: 1 }));
    const results = await Promise.all([
      cache.remember('key', loader),
      cache.remember('key', loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(results[0]).not.toBe(results[1]);
    const hit = await cache.remember('key', loader);
    expect(hit).toEqual({ count: 1 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('treats cache failures as misses/false outcomes, while preserving application errors', async () => {
    const store = new AsyncStore();
    const onError = vi.fn(() => {
      throw Error('telemetry unavailable');
    });
    const versions = new MemoryCacheInvalidationStore();
    const service = new CacheService({
      namespace: 'test',
      store,
      scope: () => publicScope,
      invalidation: versions,
      onError,
    });
    const cache = service.scope(publicScope);
    store.get = async () => {
      throw Error('read failed');
    };
    expect(await cache.remember('key', async () => 1)).toBe(1);
    expect(await cache.get('key')).toBeUndefined();
    store.set = async () => {
      throw Error('write failed');
    };
    expect(await cache.set('key', 2)).toBe(false);
    versions.invalidate = () => {
      throw Error('invalidation failed');
    };
    expect(await cache.invalidateAll()).toEqual({ ok: false, reason: 'store-error' });
    expect(onError.mock.calls.length).toBeGreaterThan(0);
    await expect(
      cache.remember('key', async () => {
        throw Error('application failed');
      }),
    ).rejects.toThrow('application failed');
  });

  it('reports swallowed cache failures to the application error reporter as well as onError', async () => {
    const onError = vi.fn();
    const failing = new AsyncStore();
    failing.get = async () => {
      throw Error('store unavailable');
    };
    @Controller('/reported')
    class Reported {
      calls = 0;
      @Get() @CacheResponse() read() {
        return { calls: ++this.calls };
      }
    }
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: 'reported',
          scope: () => publicScope,
          store: failing,
          onError,
        }),
      ],
      controllers: [Reported],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const reports: Array<{ error: unknown; context: ErrorReportContext }> = [];
    app.useGlobalExceptionHandler({
      report: (error, context) => void reports.push({ error, context }),
    });
    const response = await app.getHonoApp().request('/reported');
    expect(await response.json()).toEqual({ calls: 1 });
    expect(reports[0]?.context).toMatchObject({ edge: 'cache', source: 'read' });
    expect(String(reports[0]?.error)).toContain('store unavailable');
    expect(onError).toHaveBeenCalledWith('read', reports[0]?.error);
  });

  it('does not cache with a failed generation read or accept malformed stored values', async () => {
    const store = new AsyncStore();
    const service = createService(store);
    const cache = service.scope(publicScope);
    await cache.set('key', 1);
    const key = [...store.values.keys()][0]!;
    store.values.set(key, {
      version: 1,
      payload: '{',
      tags: [],
      generations: [],
      expiresAt: Date.now() + 1000,
    });
    expect(await cache.get('key')).toBeUndefined();
    const broken = createService(store, {
      getVersion: () => {
        throw Error('offline');
      },
      invalidate: () => {},
    }).scope(publicScope);
    expect(await broken.remember('key', async () => 2)).toBe(2);
    expect(await broken.set('key', 2)).toBe(false);
  });

  it('validates configuration and requires the optional capability for tags', async () => {
    expect(
      () =>
        new CacheService({
          namespace: '',
          store: new AsyncStore(),
          scope: () => publicScope,
        }),
    ).toThrow('namespace');
    expect(
      () =>
        new CacheService({
          namespace: 'ok',
          store: new AsyncStore(),
          scope: () => publicScope,
          ttl: NaN,
        }),
    ).toThrow('TTL');
    expect(() => CacheResponse({ ttl: -1 })).toThrow('TTL');
    expect(() => CacheResponse({ tags: [''] })).toThrow('tag');
    const cache = new CacheService({
      namespace: 'no-tags',
      store: new AsyncStore(),
      scope: () => publicScope,
    }).scope(publicScope);
    await expect(cache.set('key', 1, { tags: ['items'] })).rejects.toThrow('invalidation store');
    expect(await cache.invalidateAll()).toEqual({ ok: false, reason: 'unsupported' });
    expect(await createService().scope(publicScope).invalidateTags([''])).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('does not resurrect entries when a bounded local generation store evicts markers', async () => {
    const cache = createService(new AsyncStore(), new MemoryCacheInvalidationStore(2)).scope(
      publicScope,
    );
    await cache.set('old', 1);
    await cache.set('new', 2);
    expect(await cache.get('old')).toBeUndefined();
  });

  it('rejects secrets, streams, responses, cycles, accessors, sparse arrays and oversized values', async () => {
    const cache = createService().scope(publicScope);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const getter = vi.fn(() => 'secret');
    const accessor = Object.defineProperty({}, 'value', { get: getter, enumerable: true });
    class UnsafeArray extends Array {
      toJSON() {
        getter();
        return [1];
      }
    }
    for (const value of [
      new Response('one shot'),
      new ReadableStream(),
      { access_token: 'private' },
      { nested: { password: 'private' } },
      cycle,
      accessor,
      new Array(10001),
      new UnsafeArray(),
      'a'.repeat(65537),
      { callback() {} },
    ]) {
      expect(await cache.set('key', value)).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('response cache pipeline', () => {
  it('authorizes every hit, isolates trusted actor/tenant scopes and invalidates from a custom service', async () => {
    let calls = 0;
    let allowed = true;
    const resolved = new WeakMap<Request, CacheScope>();
    const scopes = new Map([
      ['a', privateScope('one', 'a')],
      ['b', privateScope('one', 'b')],
      ['c', privateScope('two', 'a')],
    ]);
    class Guard {
      canActivate(context: ExecutionContext) {
        const request = context.getRequest();
        const scope = scopes.get(request.headers.get('authorization') ?? '');
        if (!scope || !allowed) return false;
        resolved.set(request, scope);
        return true;
      }
    }
    @Controller('/items')
    @UseGuards(Guard)
    class Items {
      @Get()
      @CacheResponse({ tags: ['items'], key: 'same' })
      list() {
        return { calls: ++calls };
      }
    }
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: 'routes',
          store: new AsyncStore(),
          invalidation: new MemoryCacheInvalidationStore(),
          scope: (context) => resolved.get(context.getRequest()),
        }),
      ],
      controllers: [Items],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const request = (token: string) =>
      app.getHonoApp().request('/items', { headers: { authorization: token } });
    expect(await (await request('a')).json()).toEqual({ calls: 1 });
    expect(await (await request('a')).json()).toEqual({ calls: 1 });
    expect(await (await request('b')).json()).toEqual({ calls: 2 });
    expect(await (await request('c')).json()).toEqual({ calls: 3 });
    await app.get(CacheService).scope(scopes.get('a')!).invalidateTags(['items']);
    expect(await (await request('a')).json()).toEqual({ calls: 4 });
    expect(await (await request('b')).json()).toEqual({ calls: 2 });
    allowed = false;
    expect((await request('a')).status).toBe(403);
    expect(calls).toBe(4);
    await app.close();
  });

  it('keeps route/host/query variants separate and leaves undecorated and non-GET routes uncached', async () => {
    let calls = 0;
    @Controller('/cache')
    class Routes {
      @Get('/a') @CacheResponse({ key: 'same' }) a() {
        return ++calls;
      }
      @Get('/b') @CacheResponse({ key: 'same' }) b() {
        return ++calls;
      }
      @Get('/plain') plain() {
        return ++calls;
      }
      @Post('/write') @CacheResponse() write() {
        return ++calls;
      }
    }
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: 'routes',
          store: new AsyncStore(),
          scope: () => publicScope,
        }),
      ],
      controllers: [Routes],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const hono = app.getHonoApp();
    for (const path of [
      '/cache/a',
      '/cache/b',
      'https://other.test/cache/a',
      '/cache/a?q=1',
      '/cache/a?q=2',
    ]) {
      const first = await (await hono.request(path)).json();
      expect(await (await hono.request(path)).json()).toBe(first);
    }
    expect(calls).toBe(5);
    for (let i = 0; i < 2; i++) {
      await hono.request('/cache/plain');
      await hono.request('/cache/write', { method: 'POST' });
      await hono.request('/cache/a', { headers: { authorization: 'credential' } });
      await hono.request('/cache/a', { headers: { cookie: 'session=credential' } });
    }
    expect(calls).toBe(13);
    await app.close();
  });

  it('bypasses failed scopes and unsafe HTTP output', async () => {
    let calls = 0;
    @Controller('/output')
    class Routes {
      @Get('/:kind')
      @CacheResponse()
      read(@Res() context: import('hono').Context, @Headers('kind') kind: string) {
        calls++;
        if (kind === 'cookie') context.header('Set-Cookie', 'session=private');
        if (kind === 'private') context.header('Cache-Control', 'private');
        if (kind === 'status') context.res = new Response(null, { status: 202 });
        if (kind === 'response') return new Response('one shot');
        if (kind === 'secret') return { access_token: 'private' };
        return { calls };
      }
    }
    @Module({
      imports: [
        CacheModule.forRootAsync({
          inject: [],
          useFactory: async () => ({
            namespace: 'output',
            store: new AsyncStore(),
            scope: (context) => {
              if (context.getRequest().headers.get('kind') === 'scope') throw Error('bad scope');
              return publicScope;
            },
          }),
        }),
      ],
      controllers: [Routes],
    })
    class App {}
    const app = await VelaFactory.create(App);
    for (const kind of ['cookie', 'private', 'status', 'response', 'secret', 'scope']) {
      for (let i = 0; i < 2; i++)
        expect(
          (await app.getHonoApp().request(`/output/${kind}`, { headers: { kind } })).status,
        ).toBe(kind === 'status' ? 202 : 200);
    }
    expect(calls).toBe(12);
    await app.close();
  });

  it('bypasses declared cookie/private headers and non-success status metadata', async () => {
    let calls = 0;
    @Controller('/metadata')
    class Routes {
      @Get('/cookie') @CacheResponse() @Header('Set-Cookie', 'session=private') cookie() {
        return ++calls;
      }
      @Get('/private') @CacheResponse() @Header('Cache-Control', 'private') privateValue() {
        return ++calls;
      }
      @Get('/status') @CacheResponse() @HttpCode(202) status() {
        return ++calls;
      }
    }
    const store = new AsyncStore();
    @Module({
      imports: [CacheModule.forRoot({ namespace: 'metadata', store, scope: () => publicScope })],
      controllers: [Routes],
    })
    class App {}
    const app = await VelaFactory.create(App);
    for (const kind of ['cookie', 'private', 'status'])
      for (let i = 0; i < 2; i++) await app.getHonoApp().request(`/metadata/${kind}`);
    expect(calls).toBe(6);
    expect(store.values.size).toBe(0);
    await app.close();
  });

  it('rejects missing tag capability and duplicate modules at bootstrap', async () => {
    @Controller('/tags')
    class Tagged {
      @Get() @CacheResponse({ tags: ['items'] }) read() {
        return 1;
      }
    }
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: 'tags',
          store: new AsyncStore(),
          scope: () => publicScope,
        }),
      ],
      controllers: [Tagged],
    })
    class MissingTags {}
    await expect(VelaFactory.create(MissingTags)).rejects.toThrow('invalidation store');
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: 'first',
          store: new AsyncStore(),
          scope: () => publicScope,
        }),
        CacheModule.forRoot({
          namespace: 'second',
          store: new AsyncStore(),
          scope: () => publicScope,
        }),
      ],
    })
    class Duplicates {}
    await expect(VelaFactory.create(Duplicates, { diagnostics: 'throw' })).rejects.toThrow(
      /CacheModule#\w+ was imported again with different options/,
    );
    @Module({
      imports: [
        CacheModule.forRoot({
          key: 'first',
          namespace: 'first',
          store: new AsyncStore(),
          scope: () => publicScope,
        }),
        CacheModule.forRoot({
          key: 'second',
          namespace: 'second',
          store: new AsyncStore(),
          scope: () => publicScope,
        }),
      ],
    })
    class KeyedDuplicates {}
    await expect(VelaFactory.create(KeyedDuplicates)).rejects.toThrow('only one CacheModule');
  });

  it('checks inherited @CacheResponse declarations at bootstrap as the interceptor reads them', async () => {
    const boot = (controller: Type) => {
      @Module({
        imports: [
          CacheModule.forRoot({
            namespace: 'inherited',
            store: new AsyncStore(),
            scope: () => publicScope,
          }),
        ],
        controllers: [controller],
      })
      class App {}
      return VelaFactory.create(App);
    };

    // On a method the controller routes unchanged.
    class TaggedBase {
      @CacheResponse({ tags: ['items'] })
      read() {
        return 1;
      }
    }
    @Controller('/inherited-method')
    class InheritedMethod extends TaggedBase {}
    Get()(
      InheritedMethod.prototype,
      'read',
      Object.getOwnPropertyDescriptor(TaggedBase.prototype, 'read')!,
    );
    await expect(boot(InheritedMethod)).rejects.toThrow('invalidation store');

    // On an ancestor class.
    @CacheResponse({ tags: ['items'] })
    abstract class TaggedClass {}
    @Controller('/inherited-class')
    class InheritedClass extends TaggedClass {
      @Get() read() {
        return 1;
      }
    }
    await expect(boot(InheritedClass)).rejects.toThrow('invalidation store');

    // An override reads only its own declarations.
    @Controller('/overridden')
    class Overridden extends TaggedBase {
      @Get() override read() {
        return 2;
      }
    }
    const app = await boot(Overridden);
    try {
      expect(await (await app.getHonoApp().request('/overridden')).json()).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('bypasses public caching for trusted identities without credential headers', async () => {
    let calls = 0;
    class Guard {
      canActivate(context: ExecutionContext) {
        setTrustedRequestIdentity(context.getRequest(), {
          principal: { issuer: 'internal', subject: 'actor', principalType: 'service' },
        });
        return true;
      }
    }
    @Controller('/trusted')
    @UseGuards(Guard)
    class Routes {
      @Get() @CacheResponse() read() {
        return ++calls;
      }
    }
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: 'trusted',
          store: new AsyncStore(),
          scope: () => publicScope,
        }),
      ],
      controllers: [Routes],
    })
    class App {}
    const app = await VelaFactory.create(App);
    await app.getHonoApp().request('/trusted');
    await app.getHonoApp().request('/trusted');
    expect(calls).toBe(2);
    await app.close();
  });

  it('keeps independent application environments isolated', async () => {
    const makeApp = async (value: number) => {
      @Controller('/env')
      class Routes {
        @Get() @CacheResponse() read() {
          return value;
        }
      }
      @Module({
        imports: [
          CacheModule.forRoot({
            namespace: 'same',
            store: new AsyncStore(),
            scope: () => publicScope,
          }),
        ],
        controllers: [Routes],
      })
      class App {}
      return VelaFactory.create(App);
    };
    const [a, b] = await Promise.all([makeApp(1), makeApp(2)]);
    expect(await (await a.getHonoApp().request('/env')).json()).toBe(1);
    expect(await (await b.getHonoApp().request('/env')).json()).toBe(2);
    await Promise.all([a.close(), b.close()]);
  });
});

describe('one CacheModule', () => {
  @Controller('/count')
  class Counter {
    calls = 0;
    @Get() @CacheResponse() read() {
      return { calls: ++this.calls };
    }
  }

  it('caches in a per-application memory store when no store is given', async () => {
    @Module({
      imports: [CacheModule.forRoot({ namespace: 'memory', scope: () => publicScope })],
      controllers: [Counter],
    })
    class App {}
    const first = await VelaFactory.create(App);
    const second = await VelaFactory.create(App);
    const read = async (app: Awaited<ReturnType<typeof VelaFactory.create>>) =>
      (await app.getHonoApp().request('/count')).json();
    expect(await read(first)).toEqual({ calls: 1 });
    expect(await read(first)).toEqual({ calls: 1 });
    // Another application never sees the first one's entries.
    expect(await read(second)).toEqual({ calls: 1 });
    expect(first.get(CacheService).options.store).toBeInstanceOf(MemoryCacheStore);
    expect(first.get(CacheService).options.store).not.toBe(second.get(CacheService).options.store);
    await Promise.all([first.close(), second.close()]);
  });

  it('builds the store and invalidation from each application ENV', async () => {
    const stores = new Map<string, AsyncStore>();
    const storeFor = (env: VelaEnv) => {
      const name = String(Reflect.get(env, 'REGION'));
      const store = stores.get(name) ?? new AsyncStore();
      stores.set(name, store);
      return store;
    };
    const generations: VelaEnv[] = [];
    @Module({
      imports: [
        CacheModule.forRoot({
          namespace: 'env',
          scope: () => publicScope,
          store: storeFor,
          invalidation: (env) => {
            generations.push(env);
            return new MemoryCacheInvalidationStore();
          },
        }),
      ],
      controllers: [Counter],
    })
    class App {}
    const east = await VelaFactory.create(App, { env: { REGION: 'east' } });
    const west = await VelaFactory.create(App, { env: { REGION: 'west' } });
    await east.getHonoApp().request('/count');
    expect(stores.get('east')!.values.size).toBe(1);
    expect(stores.get('west')!.values.size).toBe(0);
    await west.getHonoApp().request('/count');
    expect(stores.get('west')!.values.size).toBe(1);
    expect(generations.map((env) => Reflect.get(env, 'REGION'))).toEqual(['east', 'west']);
    await Promise.all([east.close(), west.close()]);
  });

  it('keeps namespace and scope mandatory', () => {
    const missingScope = { namespace: 'x' } as unknown as CacheModuleOptions;
    expect(() => new CacheService(missingScope)).toThrow('trusted scope resolver');
    expect(() => new CacheService({ namespace: '', scope: () => publicScope })).toThrow(
      'Cache namespace',
    );
    expect(() => new CacheService({ namespace: 'x', scope: () => publicScope, max: 0 })).toThrow(
      'max must be a positive integer',
    );
    // @ts-expect-error namespace is required
    void (() => CacheModule.forRoot({ scope: () => publicScope }));
    // @ts-expect-error scope is required
    void (() => CacheModule.forRoot({ namespace: 'x' }));
  });

  it('evicts the default memory store at capacity', () => {
    const store = new MemoryCacheStore(30, 2);
    store.set('a', 1);
    store.set('b', 2);
    store.set('c', 3);
    expect(store.get('a')).toBeUndefined();
    expect([store.get('b'), store.get('c')]).toEqual([2, 3]);
  });
});
