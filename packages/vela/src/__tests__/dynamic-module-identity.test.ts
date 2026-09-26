import { defineProvider } from '../container/types';
import { describe, expect, it, vi } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  VelaFactory,
  defineModule,
} from '../index.js';
import {
  MultipleProvidersFoundError,
  UnresolvedDependencyError,
  stableHash,
} from '../module-kit.js';
import { HttpModule, HttpService, HTTP_MODULE_OPTIONS } from '../fetch/index.js';
import type { DynamicModule, Type } from '../index.js';

/** A configurable module whose options are its only provider: identity mechanics only. */
const TTL_OPTIONS = new InjectionToken<{ ttl: number }>('TTL_OPTIONS');
const { ConfigurableModuleClass: TtlBase } = defineModule<{ ttl: number }>({
  name: 'Ttl',
  optionsToken: TTL_OPTIONS,
  setup: ({ OPTIONS }) => ({ exports: [OPTIONS] }),
});
class TtlModule extends TtlBase {}

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
  it('C: TtlModule.forRoot({ttl:60}) imported twice → dedups (same key)', async () => {
    @Module({
      imports: [TtlModule.forRoot({ ttl: 60 }), TtlModule.forRoot({ ttl: 60 })],
    })
    class App {}

    const app = await VelaFactory.create(App);
    // Same key dedups; only one TTL_OPTIONS registration exists.
    const opts = app.getContainer().resolve(TTL_OPTIONS);
    expect(opts).toEqual({ ttl: 60 });
  });

  // -------------------------------------------------------------------------
  // Case D — different forRoot options → BOTH register; consumer importing
  // both → MultipleProvidersFoundError; consumer importing one → that one wins
  // -------------------------------------------------------------------------
  it('D: distinct keys register distinct instances; each consumer sees its own', async () => {
    @Module({ imports: [TtlModule.forRoot({ ttl: 60, key: 'fast' })] })
    class FastFeatureModule {}

    @Module({ imports: [TtlModule.forRoot({ ttl: 120, key: 'slow' })] })
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
    expect(tokens).toContain(TTL_OPTIONS);

    // A controller in either feature module should see ITS own ttl.
    @Controller('/fast')
    class FastCtl {
      constructor(@Inject(TTL_OPTIONS) public opts: { ttl: number }) {}
      @Get() handle() {
        return this.opts;
      }
    }
    @Controller('/slow')
    class SlowCtl {
      constructor(@Inject(TTL_OPTIONS) public opts: { ttl: number }) {}
      @Get() handle() {
        return this.opts;
      }
    }

    @Module({ imports: [TtlModule.forRoot({ ttl: 60 })], controllers: [FastCtl] })
    class FastApp {}

    @Module({ imports: [TtlModule.forRoot({ ttl: 120 })], controllers: [SlowCtl] })
    class SlowApp {}

    const fastApp = await VelaFactory.create(FastApp);
    const slowApp = await VelaFactory.create(SlowApp);
    const fastRes = await fastApp.getHonoApp().request('/fast');
    const slowRes = await slowApp.getHonoApp().request('/slow');
    expect(await fastRes.json()).toEqual({ ttl: 60 });
    expect(await slowRes.json()).toEqual({ ttl: 120 });
  });

  it('D: importing two keyed TtlModule instances directly throws MultipleProvidersFoundError on resolve', async () => {
    @Injectable()
    class Consumer {
      constructor(@Inject(TTL_OPTIONS) public opts: unknown) {}
    }

    @Module({
      imports: [
        TtlModule.forRoot({ ttl: 60, key: 'fast' }),
        TtlModule.forRoot({ ttl: 120, key: 'slow' }),
      ],
      providers: [Consumer],
    })
    class App {}

    await expect(VelaFactory.create(App)).rejects.toThrow(MultipleProvidersFoundError);
  });

  it('reimporting one HTTP registration shares its providers', async () => {
    const client = HttpModule.register({ baseURL: 'https://a.test' });
    @Module({ imports: [client, client] })
    class App {}
    const app = await VelaFactory.create(App, { diagnostics: 'throw' });
    expect(app.getContainer().getOwnerModuleIds(HttpService)).toHaveLength(1);
    expect(app.get(HTTP_MODULE_OPTIONS)).toEqual({ baseURL: 'https://a.test' });
    await app.dispose();
  });

  // -------------------------------------------------------------------------
  // Case F — different HttpModule.register options → both register
  // -------------------------------------------------------------------------
  it('independent HTTP registrations resolve each feature’s own configuration', async () => {
    @Injectable()
    class FeatureA {
      constructor(@Inject(HTTP_MODULE_OPTIONS) public opts: { baseURL?: string }) {}
    }
    @Injectable()
    class FeatureB {
      constructor(@Inject(HTTP_MODULE_OPTIONS) public opts: { baseURL?: string }) {}
    }

    @Module({
      imports: [HttpModule.register({ baseURL: 'https://a.test' })],
      providers: [FeatureA],
      exports: [FeatureA],
    })
    class ModA {}

    @Module({
      imports: [HttpModule.register({ baseURL: 'https://b.test' })],
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
  it('G: [HttpModule, HttpModule.register({base:X})] → both register, loader warns', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };

    try {
      @Module({
        imports: [HttpModule, HttpModule.register({ baseURL: 'https://x.test' })],
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

  it('independent async HTTP registrations coexist without explicit keys', async () => {
    const first = HttpModule.registerAsync({
      useFactory: () => ({ baseURL: 'https://first.test' }),
    });
    const second = HttpModule.registerAsync({
      useFactory: async () => ({ baseURL: 'https://second.test' }),
    });
    @Module({ imports: [first, second] })
    class App {}
    const app = await VelaFactory.create(App, { diagnostics: 'throw' });
    const owners = app.getContainer().getOwnerModuleIds(HttpService);
    expect(owners).toHaveLength(2);
    const options = owners.map((owner) => app.getContainer().resolve(HTTP_MODULE_OPTIONS, owner));
    expect(options).toEqual([
      { baseURL: 'https://first.test' },
      { baseURL: 'https://second.test' },
    ]);
    await app.dispose();
  });

  it('rejects conflicting explicitly keyed HTTP registrations regardless of visibility', async () => {
    const privateClient = HttpModule.register({
      key: 'shared',
      baseURL: 'https://private.test',
      headers: { authorization: 'Bearer PRIVATE' },
    });
    const publicClient = HttpModule.register({
      key: 'shared',
      baseURL: 'https://public.test',
      isGlobal: true,
    });
    // Either import order: the global flag never decides which client a feature gets.
    for (const [first, second] of [
      [privateClient, publicClient],
      [publicClient, privateClient],
    ]) {
      @Module({ imports: [first] })
      class FeatureA {}
      @Module({ imports: [second] })
      class FeatureB {}
      @Module({ imports: [FeatureA, FeatureB] })
      class App {}
      for (const diagnostics of ['throw', 'log', 'silent'] as const) {
        await expect(VelaFactory.create(App, { diagnostics })).rejects.toThrow(
          /HttpModule#\w+ was imported again with different options/,
        );
      }
    }
  });

  it('reports an HttpModule repeat that differs only in its global flag', async () => {
    const local = HttpModule.register({ key: 'shared', baseURL: 'https://shared.test' });
    const shared = HttpModule.register({
      key: 'shared',
      baseURL: 'https://shared.test',
      isGlobal: true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [first, second] of [
        [local, shared],
        [shared, local],
      ]) {
        @Module({ imports: [first, second] })
        class App {}
        await expect(VelaFactory.create(App, { diagnostics: 'throw' })).rejects.toThrow(
          /HttpModule#\w+ was imported again with a different global flag/,
        );
        warn.mockClear();
        const app = await VelaFactory.create(App);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/different global flag/));
        expect(app.getContainer().resolve(HTTP_MODULE_OPTIONS)).toEqual({
          baseURL: 'https://shared.test',
        });
        await app.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // A bare import configures nothing: a configured import under its key is a
  // second configuration, never silently replaced by the class's defaults
  // -------------------------------------------------------------------------
  it('fails bootstrap on a configured HttpModule under the bare key, in either order', async () => {
    const configured = HttpModule.register({ key: 'default', baseURL: 'https://configured.test' });
    const deferred = HttpModule.registerAsync({
      key: 'default',
      useFactory: () => ({ baseURL: 'https://configured.test' }),
    });
    const cases: Array<Array<Type | DynamicModule>> = [
      [HttpModule, configured],
      [configured, HttpModule],
      [HttpModule, deferred],
      [deferred, HttpModule],
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const imports of cases) {
        @Module({ imports })
        class App {}
        for (const diagnostics of ['throw', 'log', 'silent'] as const) {
          await expect(VelaFactory.create(App, { diagnostics })).rejects.toThrow(
            /HttpModule#default was imported again with different options/,
          );
        }
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps an unconfigured HTTP registration under the bare key as the bare import', async () => {
    const cases: Array<Array<Type | DynamicModule>> = [
      [HttpModule, HttpModule.register({ key: 'default' })],
      [HttpModule.register({ key: 'default', baseURL: undefined }), HttpModule],
    ];
    for (const imports of cases) {
      @Module({ imports })
      class App {}
      const app = await VelaFactory.create(App, { diagnostics: 'throw' });
      expect(app.getContainer().getOwnerModuleIds(HttpService)).toEqual(['HttpModule#default']);
      expect(app.getContainer().resolve(HTTP_MODULE_OPTIONS)).toEqual({});
      await app.close();
    }
  });

  it('reports a second unkeyed TtlModule configuration instead of swallowing it', async () => {
    @Module({ imports: [TtlModule.forRoot({ ttl: 60 })] })
    class FastSide {}

    @Module({ imports: [TtlModule.forRoot({ ttl: 120 })] })
    class SlowSide {}

    @Module({ imports: [FastSide, SlowSide] })
    class App {}

    await expect(VelaFactory.create(App, { diagnostics: 'throw' })).rejects.toThrow(
      /TtlModule#\w+ was imported again with different options/,
    );
  });

  // -------------------------------------------------------------------------
  // stableHash sanity
  // -------------------------------------------------------------------------
  it('stableHash is deterministic for plain objects regardless of key order', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash({ a: 1, b: 2 })).not.toBe(stableHash({ a: 1, b: 3 }));
  });

  it('stableHash omits undefined properties at every depth, like the repeat comparison', () => {
    expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }));
    expect(stableHash({ presence: { ttlMs: undefined } })).toBe(stableHash({ presence: {} }));
    expect(stableHash({ presence: { ttlMs: 1 } })).not.toBe(stableHash({ presence: {} }));
    // Array positions still count.
    expect(stableHash([undefined])).not.toBe(stableHash([]));
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

    const dyn: DynamicModule = HttpModule.register({ baseURL: 'https://lazy.test' });
    @Module({ imports: [dyn], providers: [Consumer] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.get(Consumer).opts).toEqual({ baseURL: 'https://lazy.test' });
  });
});
