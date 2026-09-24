import { defineProvider } from '../container/types';
import { describe, it, expect, vi } from 'vitest';
import {
  APP_GUARD,
  Controller,
  Get,
  Global,
  Injectable,
  InjectionToken,
  Module,
  VelaFactory,
  defineModule,
} from '../index.js';
import { lazyProvider, sideEffectModule, stableHash } from '../module-kit.js';
import type { CanActivate, DynamicModule } from '../index.js';

interface WidgetOptions {
  color?: string;
  size?: number;
}

const WIDGET_OPTIONS = new InjectionToken<WidgetOptions>('WIDGET_OPTIONS_TEST');

describe('defineModule', () => {
  it('generates forRoot with a structural key and the options provider', () => {
    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<WidgetOptions, 'color'>({
      name: 'Widget',
      optionsToken: WIDGET_OPTIONS,
      structural: ['color'],
    });
    class WidgetModule extends ConfigurableModuleClass {}

    const dyn = WidgetModule.forRoot({ color: 'red', size: 1 });
    expect(dyn.module).toBe(WidgetModule);
    expect(dyn.key).toBe(stableHash({ color: 'red' }));
    expect(MODULE_OPTIONS_TOKEN).toBe(WIDGET_OPTIONS);
    expect(dyn.providers).toContainEqual(
      defineProvider(WIDGET_OPTIONS, { useValue: { color: 'red', size: 1 } }),
    );

    // Structural fields decide the key; other options never do; explicit key wins.
    expect(WidgetModule.forRoot({ color: 'red', size: 2 }).key).toBe(dyn.key);
    expect(WidgetModule.forRoot({ color: 'blue' }).key).not.toBe(dyn.key);
    expect(WidgetModule.forRoot({ color: 'red', key: 'A' }).key).toBe('A');
  });

  it('spec.key overrides the default derivation', () => {
    const { ConfigurableModuleClass } = defineModule<WidgetOptions, 'color'>({
      name: 'Widget',
      structural: ['color'],
      key: (o) => `w#${o.color ?? 'none'}`,
    });
    class WidgetModule extends ConfigurableModuleClass {}

    expect(WidgetModule.forRoot({ color: 'red', size: 1 }).key).toBe('w#red');
    expect(WidgetModule.forRoot({ color: 'red', size: 2 }).key).toBe('w#red');
  });

  it('setup() contributes providers/exports computed from structural options, and the global slot lowers to APP_* wiring', () => {
    const SIZE = new InjectionToken<number>('WIDGET_SIZE_TEST');

    @Injectable()
    class WidgetGuard implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }

    const { ConfigurableModuleClass } = defineModule<WidgetOptions, 'size'>({
      name: 'Widget',
      structural: ['size'],
      setup: ({ OPTIONS, options }) => ({
        providers: [
          defineProvider(SIZE, {
            useFactory: (o: WidgetOptions) => (o.size ?? 0) * 2,
            inject: [OPTIONS],
          }),
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
    expect(dyn.providers).toContainEqual(defineProvider(APP_GUARD, { useExisting: WidgetGuard }));
  });

  it('forRootAsync completes the resolved options with the structural fields', async () => {
    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<WidgetOptions, 'size'>({
      name: 'Widget',
      structural: ['size'],
    });
    class WidgetModule extends ConfigurableModuleClass {}

    @Module({
      imports: [
        WidgetModule.forRootAsync({ inject: [], size: 7, useFactory: () => ({ color: 'green' }) }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const resolved = await app.getContainer().resolveAsync<WidgetOptions>(MODULE_OPTIONS_TOKEN);
    expect(resolved).toEqual({ size: 7, color: 'green' });
  });

  it('an app actually resolves derived providers wired through setup()', async () => {
    const LABEL = new InjectionToken<string>('WIDGET_LABEL_TEST');
    const { ConfigurableModuleClass } = defineModule<WidgetOptions>({
      name: 'Widget',
      setup: ({ OPTIONS }) => ({
        providers: [
          defineProvider(LABEL, {
            useFactory: (o: WidgetOptions) => `widget:${o.color}`,
            inject: [OPTIONS],
          }),
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

    @Global()
    @Module({
      providers: [lazyProvider(defineProvider(THUNK, { inject: [], useFactory: () => build() }))],
      exports: [THUNK],
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

    @Global()
    @Module({
      providers: [
        lazyProvider({ inject: [], provide: THUNK, useFactory: () => build(), memoize: false }),
      ],
      exports: [THUNK],
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

describe('sideEffectModule', () => {
  it('string owners stay isolated even for identical contributions', async () => {
    const MSGS = new InjectionToken<string[]>('SIDE_EFFECT_MSGS_TEST');
    const contribution = (): DynamicModule =>
      sideEffectModule('TestMessages', {
        providers: [defineProvider(MSGS, { useValue: ['hello'] })],
        exports: [MSGS],
      });

    const a = contribution();
    const b = contribution();
    expect(a.module.name).toBe('TestMessages');
    // Equal keys do not merge separate class owners.
    expect(a.key).toBe(b.key);
    expect(a.module).not.toBe(b.module);

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
});
