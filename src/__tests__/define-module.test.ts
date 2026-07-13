import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  APP_GUARD,
  Controller,
  Get,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  VelaFactory,
  defineModule,
  lazyProvider,
  moduleKey,
  moduleToken,
  provideGlobal,
  sideEffectModule,
  stableHash,
} from '../index.js';
import type { CanActivate, DynamicModule } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

interface WidgetOptions {
  color?: string;
  size?: number;
}

const WIDGET_OPTIONS = new InjectionToken<WidgetOptions>('WIDGET_OPTIONS_TEST');

describe('defineModule', () => {
  it('generates forRoot with a stableHash-derived key and the options provider', () => {
    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<WidgetOptions>({
      name: 'Widget',
      optionsToken: WIDGET_OPTIONS,
    });
    class WidgetModule extends ConfigurableModuleClass {}

    const dyn = WidgetModule.forRoot({ color: 'red' });
    expect(dyn.module).toBe(WidgetModule);
    expect(dyn.key).toBe(stableHash({ color: 'red' }));
    expect(MODULE_OPTIONS_TOKEN).toBe(WIDGET_OPTIONS);
    expect(dyn.providers).toContainEqual({ provide: WIDGET_OPTIONS, useValue: { color: 'red' } });

    // Identical options dedup; distinct coexist; explicit key wins.
    expect(WidgetModule.forRoot({ color: 'red' }).key).toBe(dyn.key);
    expect(WidgetModule.forRoot({ color: 'blue' }).key).not.toBe(dyn.key);
    expect(WidgetModule.forRoot({ color: 'red', key: 'A' }).key).toBe('A');
  });

  it('spec.key overrides the default derivation', () => {
    const { ConfigurableModuleClass } = defineModule<WidgetOptions>({
      name: 'Widget',
      key: (o) => `w#${o.color ?? 'none'}`,
    });
    class WidgetModule extends ConfigurableModuleClass {}

    expect(WidgetModule.forRoot({ color: 'red', size: 1 }).key).toBe('w#red');
    expect(WidgetModule.forRoot({ color: 'red', size: 2 }).key).toBe('w#red');
  });

  it('setup() contributes providers/exports computed from options, and the global slot lowers to APP_* wiring', () => {
    const SIZE = new InjectionToken<number>('WIDGET_SIZE_TEST');

    @Injectable()
    class WidgetGuard implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }

    const { ConfigurableModuleClass } = defineModule<WidgetOptions>({
      name: 'Widget',
      setup: ({ OPTIONS, options }) => ({
        providers: [
          {
            provide: SIZE,
            useFactory: (o: WidgetOptions) => (o.size ?? 0) * 2,
            inject: [OPTIONS],
          },
        ],
        exports: [SIZE],
        global: options.size !== undefined ? { guards: [WidgetGuard] } : undefined,
      }),
    });
    class WidgetModule extends ConfigurableModuleClass {}

    const dyn = WidgetModule.forRoot({ size: 21 });
    expect(dyn.exports).toContain(SIZE);
    // global slot: class registered as provider + APP_GUARD useExisting
    expect(dyn.providers).toContain(WidgetGuard);
    expect(dyn.providers).toContainEqual({ provide: APP_GUARD, useExisting: WidgetGuard });
  });

  it('forRootAsync merges structural fields under the resolved options', async () => {
    const seen: WidgetOptions[] = [];

    @Injectable()
    class Probe {
      constructor() {}
    }

    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<WidgetOptions>({
      name: 'Widget',
    });
    class WidgetModule extends ConfigurableModuleClass {}

    @Module({
      imports: [WidgetModule.forRootAsync({ size: 7, useFactory: () => ({ color: 'green' }) })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const resolved = await app.getContainer().resolveAsync<WidgetOptions>(MODULE_OPTIONS_TOKEN);
    seen.push(resolved);
    expect(resolved).toEqual({ size: 7, color: 'green' });
    void Probe;
  });

  it('an app actually resolves derived providers wired through setup()', async () => {
    const LABEL = new InjectionToken<string>('WIDGET_LABEL_TEST');
    const { ConfigurableModuleClass } = defineModule<WidgetOptions>({
      name: 'Widget',
      setup: ({ OPTIONS }) => ({
        providers: [
          {
            provide: LABEL,
            useFactory: (o: WidgetOptions) => `widget:${o.color}`,
            inject: [OPTIONS],
          },
        ],
        exports: [LABEL],
      }),
    });
    class WidgetModule extends ConfigurableModuleClass {}

    @Module({ imports: [WidgetModule.forRoot({ color: 'red' })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(LABEL)).toBe('widget:red');
  });
});

describe('lazyProvider', () => {
  it('defers the factory until first call and memoizes by default', async () => {
    const build = vi.fn(() => ({ id: 1 }));
    const THUNK = new InjectionToken<() => { id: number }>('LAZY_TEST');

    @Module({
      providers: [lazyProvider({ provide: THUNK, useFactory: () => build() })],
      exports: [THUNK],
      isGlobal: true,
    })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const thunk = app.get(THUNK);
    expect(build).not.toHaveBeenCalled();

    const first = thunk();
    const second = thunk();
    expect(build).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('memoize: false rebuilds per call', async () => {
    const build = vi.fn(() => ({}));
    const THUNK = new InjectionToken<() => object>('LAZY_NO_MEMO_TEST');

    @Module({
      providers: [lazyProvider({ provide: THUNK, useFactory: () => build(), memoize: false })],
      exports: [THUNK],
      isGlobal: true,
    })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const thunk = app.get(THUNK);
    expect(thunk()).not.toBe(thunk());
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe('provideGlobal / sideEffectModule / moduleToken / moduleKey', () => {
  it('provideGlobal returns the class provider + APP_* useExisting pair', () => {
    @Injectable()
    class G implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }
    expect(provideGlobal('guard', G)).toEqual([G, { provide: APP_GUARD, useExisting: G }]);

    const instance = { canActivate: () => true };
    expect(provideGlobal('guard', instance)).toEqual([{ provide: APP_GUARD, useValue: instance }]);
  });

  it('sideEffectModule mints a named module whose identical contributions dedup', async () => {
    const MSGS = new InjectionToken<string[]>('SIDE_EFFECT_MSGS_TEST');
    const contribution = (): DynamicModule =>
      sideEffectModule('TestMessages', {
        providers: [{ provide: MSGS, useValue: ['hello'] }],
        exports: [MSGS],
      });

    const a = contribution();
    const b = contribution();
    expect(a.module.name).toBe('TestMessages');
    // Distinct minted classes but content-identical keys — the loader treats
    // them as different module classes, so no MultipleProvidersFoundError.
    expect(a.key).toBe(b.key);

    @Controller('/m')
    class MController {
      constructor() {}
      @Get() list() {
        return [];
      }
    }

    @Module({ imports: [a, b], controllers: [MController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app).toBeDefined();
  });

  it('moduleToken mints an InjectionToken; moduleKey is stableHash', () => {
    const t = moduleToken<number>('pkg:area:thing');
    expect(t).toBeInstanceOf(InjectionToken);
    expect(moduleKey({ a: 1 })).toBe(stableHash({ a: 1 }));
  });
});
