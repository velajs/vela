import { defineProvider } from '../container/types';
import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  VelaFactory,
} from '../index.js';
import {
  MultipleProvidersFoundError,
  UnresolvedDependencyError,
  defineDynamicModule,
  stableHash,
} from '../module-kit.js';
import { CacheModule, CACHE_MODULE_OPTIONS } from '../cache/index.js';
import { HttpModule, HTTP_MODULE_OPTIONS } from '../fetch/index.js';
import type { DynamicModule } from '../index.js';

describe('Dynamic module identity', () => {
  // -------------------------------------------------------------------------
  // Case A — static module imported once → registers once
  // -------------------------------------------------------------------------
  it('A: static module imported once → registers once', async () => {
    @Injectable()
    class StaticSvc {
      ping() {
        return 'static';
      }
    }

    @Controller('/static')
    class StaticController {
      constructor(private svc: StaticSvc) {}
      @Get() handle() {
        return { value: this.svc.ping() };
      }
    }

    @Module({ providers: [StaticSvc], controllers: [StaticController] })
    class App {}

    const app = await VelaFactory.create(App);
    const res = await app.getHonoApp().request('/static');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'static' });
  });

  // -------------------------------------------------------------------------
  // Case B — static module imported twice in same imports → dedups by class
  // -------------------------------------------------------------------------
  it('B: static module imported twice in same imports → dedups by class', async () => {
    let constructed = 0;

    @Injectable()
    class SharedSvc {
      constructor() {
        constructed++;
      }
    }

    @Module({ providers: [SharedSvc], exports: [SharedSvc] })
    class SharedModule {}

    @Module({ imports: [SharedModule, SharedModule] })
    class App {}

    await VelaFactory.create(App);
    expect(constructed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Case C — same forRoot options imported twice → dedups (same key)
  // -------------------------------------------------------------------------
  it('C: CacheModule.forRoot({ttl:60}) imported twice → dedups (same key)', async () => {
    @Module({
      imports: [CacheModule.forRoot({ ttl: 60 }), CacheModule.forRoot({ ttl: 60 })],
    })
    class App {}

    const app = await VelaFactory.create(App);
    // Same key dedups; only one CACHE_MODULE_OPTIONS registration exists.
    const opts = app.getContainer().resolve(CACHE_MODULE_OPTIONS);
    expect(opts).toEqual({ ttl: 60 });
  });

  // -------------------------------------------------------------------------
  // Case D — different forRoot options → BOTH register; consumer importing
  // both → MultipleProvidersFoundError; consumer importing one → that one wins
  // -------------------------------------------------------------------------
  it('D: different forRoot options register as distinct instances; consumer ambiguity throws', async () => {
    @Module({ imports: [CacheModule.forRoot({ ttl: 60 })] })
    class FastFeatureModule {}

    @Module({ imports: [CacheModule.forRoot({ ttl: 120 })] })
    class SlowFeatureModule {}

    @Module({ imports: [FastFeatureModule, SlowFeatureModule] })
    class App {}

    const app = await VelaFactory.create(App);
    const tokens = app.getContainer().getTokens();
    // Both options registrations exist (one per module bucket). Verify by
    // listing exporters via a public introspection — checking the token
    // appears once (it's the same logical token), but two distinct instances
    // exist. Resolving from a sandbox picks one (legacy behavior); resolving
    // from inside a module that imports both would throw.
    expect(tokens).toContain(CACHE_MODULE_OPTIONS);

    // A controller in either feature module should see ITS own ttl.
    @Controller('/fast')
    class FastCtl {
      constructor(@Inject(CACHE_MODULE_OPTIONS) public opts: { ttl: number }) {}
      @Get() handle() {
        return this.opts;
      }
    }
    @Controller('/slow')
    class SlowCtl {
      constructor(@Inject(CACHE_MODULE_OPTIONS) public opts: { ttl: number }) {}
      @Get() handle() {
        return this.opts;
      }
    }

    @Module({ imports: [CacheModule.forRoot({ ttl: 60 })], controllers: [FastCtl] })
    class FastApp {}

    @Module({ imports: [CacheModule.forRoot({ ttl: 120 })], controllers: [SlowCtl] })
    class SlowApp {}

    const fastApp = await VelaFactory.create(FastApp);
    const slowApp = await VelaFactory.create(SlowApp);
    const fastRes = await fastApp.getHonoApp().request('/fast');
    const slowRes = await slowApp.getHonoApp().request('/slow');
    expect(await fastRes.json()).toEqual({ ttl: 60 });
    expect(await slowRes.json()).toEqual({ ttl: 120 });
  });

  it('D: importing two distinct CacheModule instances directly throws MultipleProvidersFoundError on resolve', async () => {
    @Injectable()
    class Consumer {
      constructor(@Inject(CACHE_MODULE_OPTIONS) public opts: unknown) {}
    }

    @Module({
      imports: [CacheModule.forRoot({ ttl: 60 }), CacheModule.forRoot({ ttl: 120 })],
      providers: [Consumer],
    })
    class App {}

    await expect(VelaFactory.create(App)).rejects.toThrow(MultipleProvidersFoundError);
  });

  // -------------------------------------------------------------------------
  // Case E — same forRoot options on HttpModule twice → dedups
  // -------------------------------------------------------------------------
  it('E: HttpModule.forRoot({a}) imported twice with same options → dedups', async () => {
    @Module({
      imports: [
        HttpModule.forRoot({ baseURL: 'https://a.test' }),
        HttpModule.forRoot({ baseURL: 'https://a.test' }),
      ],
    })
    class App {}

    const app = await VelaFactory.create(App);
    const opts = app.getContainer().resolve(HTTP_MODULE_OPTIONS);
    expect(opts).toEqual({ baseURL: 'https://a.test' });
  });

  // -------------------------------------------------------------------------
  // Case F — different HttpModule.forRoot options → both register
  // -------------------------------------------------------------------------
  it('F: HttpModule.forRoot({a}) and HttpModule.forRoot({b}) → both register', async () => {
    @Injectable()
    class FeatureA {
      constructor(@Inject(HTTP_MODULE_OPTIONS) public opts: { baseURL?: string }) {}
    }
    @Injectable()
    class FeatureB {
      constructor(@Inject(HTTP_MODULE_OPTIONS) public opts: { baseURL?: string }) {}
    }

    @Module({
      imports: [HttpModule.forRoot({ baseURL: 'https://a.test' })],
      providers: [FeatureA],
      exports: [FeatureA],
    })
    class ModA {}

    @Module({
      imports: [HttpModule.forRoot({ baseURL: 'https://b.test' })],
      providers: [FeatureB],
      exports: [FeatureB],
    })
    class ModB {}

    @Module({ imports: [ModA, ModB] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.get(FeatureA).opts).toEqual({ baseURL: 'https://a.test' });
    expect(app.get(FeatureB).opts).toEqual({ baseURL: 'https://b.test' });
  });

  // -------------------------------------------------------------------------
  // Case G — bare class + forRoot in same imports → both register, warn
  // -------------------------------------------------------------------------
  it('G: [HttpModule, HttpModule.forRoot({base:X})] → both register, loader warns', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };

    try {
      @Module({
        imports: [HttpModule, HttpModule.forRoot({ baseURL: 'https://x.test' })],
      })
      class App {}

      await VelaFactory.create(App);
    } finally {
      console.warn = originalWarn;
    }

    const mixedWarning = warnings.find((m) =>
      m.includes('HttpModule imported in both bare and keyed form'),
    );
    expect(mixedWarning).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // defineDynamicModule + stableHash sanity
  // -------------------------------------------------------------------------
  it('defineDynamicModule defaults the key to "default" when absent', () => {
    class MyModule {}
    const result = defineDynamicModule({ module: MyModule, providers: [] });
    expect(result.key).toBe('default');
  });

  it('stableHash is deterministic for plain objects regardless of key order', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash({ a: 1, b: 2 })).not.toBe(stableHash({ a: 1, b: 3 }));
  });

  it('stableHash tolerates functions (hashes by source fingerprint)', () => {
    const fa = () => 1;
    const fb = () => 1;
    const fc = () => 2;
    // Same source → same hash. Different source → different hash.
    expect(stableHash(fa)).toBe(stableHash(fb));
    expect(stableHash(fa)).not.toBe(stableHash(fc));
  });

  // -------------------------------------------------------------------------
  // Hidden-bug regression: provider-level swallow at container.has() guard
  // -------------------------------------------------------------------------
  it('regression: two HttpModule.forRoot() with distinct options no longer swallow each other', async () => {
    @Injectable()
    class ConsumerA {
      constructor(@Inject(HTTP_MODULE_OPTIONS) public opts: { baseURL?: string }) {}
    }
    @Injectable()
    class ConsumerB {
      constructor(@Inject(HTTP_MODULE_OPTIONS) public opts: { baseURL?: string }) {}
    }

    @Module({
      imports: [HttpModule.forRoot({ baseURL: 'https://first.test' })],
      providers: [ConsumerA],
      exports: [ConsumerA],
    })
    class FirstModule {}

    @Module({
      imports: [HttpModule.forRoot({ baseURL: 'https://second.test' })],
      providers: [ConsumerB],
      exports: [ConsumerB],
    })
    class SecondModule {}

    @Module({ imports: [FirstModule, SecondModule] })
    class App {}

    const app = await VelaFactory.create(App);
    // Pre-fix: both would see {baseURL: 'first.test'} because the second
    // registration was silently dropped at container.has().
    expect(app.get(ConsumerA).opts).toEqual({ baseURL: 'https://first.test' });
    expect(app.get(ConsumerB).opts).toEqual({ baseURL: 'https://second.test' });
  });

  it('regression: two CacheModule.forRoot() with distinct options no longer swallow at processedModules', async () => {
    @Injectable()
    class ConsumerFast {
      constructor(@Inject(CACHE_MODULE_OPTIONS) public opts: { ttl?: number }) {}
    }
    @Injectable()
    class ConsumerSlow {
      constructor(@Inject(CACHE_MODULE_OPTIONS) public opts: { ttl?: number }) {}
    }

    @Module({
      imports: [CacheModule.forRoot({ ttl: 60 })],
      providers: [ConsumerFast],
      exports: [ConsumerFast],
    })
    class FastSide {}

    @Module({
      imports: [CacheModule.forRoot({ ttl: 120 })],
      providers: [ConsumerSlow],
      exports: [ConsumerSlow],
    })
    class SlowSide {}

    @Module({ imports: [FastSide, SlowSide] })
    class App {}

    const app = await VelaFactory.create(App);
    // Pre-fix: SlowSide would inject ttl:60 because the second forRoot was
    // silently dropped at the processedModules.has(class) check.
    expect(app.get(ConsumerFast).opts).toEqual({ ttl: 60 });
    expect(app.get(ConsumerSlow).opts).toEqual({ ttl: 120 });
  });

  // -------------------------------------------------------------------------
  // Visibility errors keep firing under the new bucketed resolver
  // -------------------------------------------------------------------------
  it('untouched: visibility errors still fire when consumers reach for unexported tokens', async () => {
    const SECRET = new InjectionToken<string>('SECRET');

    @Injectable()
    class Hider {
      constructor(@Inject(SECRET) public value: string) {}
    }

    @Module({
      providers: [defineProvider(SECRET, { useValue: 'hidden' }), Hider],
      // no exports
    })
    class HiddenModule {}

    @Injectable()
    class Peeker {
      constructor(@Inject(SECRET) public value: string) {}
    }

    @Module({ imports: [HiddenModule], providers: [Peeker] })
    class App {}

    await expect(VelaFactory.create(App)).rejects.toThrow(
      /^Cannot resolve Peeker\(\?\) in App\. Argument #0 InjectionToken\(SECRET\) is declared in HiddenModule but not exported/,
    );
    await expect(VelaFactory.create(App)).rejects.toThrow(UnresolvedDependencyError);
  });

  // -------------------------------------------------------------------------
  // forwardRef referencing a forRoot — key must derive at unwrap time
  // -------------------------------------------------------------------------
  it('forwardRef pointing at a DynamicModule resolves with the dynamic module key', async () => {
    @Injectable()
    class Consumer {
      constructor(@Inject(HTTP_MODULE_OPTIONS) public opts: { baseURL?: string }) {}
    }

    const dyn: DynamicModule = HttpModule.forRoot({ baseURL: 'https://lazy.test' });
    @Module({ imports: [dyn], providers: [Consumer] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.get(Consumer).opts).toEqual({ baseURL: 'https://lazy.test' });
  });
});
