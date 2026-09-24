import { defineProvider } from '../container/types';
import { describe, it, expect } from 'vitest';
import {
  VelaFactory,
  Module,
  Injectable,
  Inject,
  ConfigurableModuleBuilder,
  type ProviderOptions,
} from '../index.js';

interface WidgetOptions {
  color: string;
  size?: number;
}

describe('ConfigurableModuleBuilder', () => {
  describe('register (sync)', () => {
    it('emits a DynamicModule referencing the subclass with an options provider and a stable key', () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<WidgetOptions>({
          moduleName: 'Widget',
        }).build();
      @Module({})
      class WidgetModule extends ConfigurableModuleClass {}

      const dyn = WidgetModule.register({ color: 'red' });
      expect(dyn.module).toBe(WidgetModule);
      expect(typeof dyn.key).toBe('string');
      expect(dyn.global).toBeUndefined();
      expect(dyn.providers).toEqual([
        defineProvider(MODULE_OPTIONS_TOKEN, { useValue: { color: 'red' } }),
      ]);
    });

    it('keys one instance per class: a different configuration reuses the key', () => {
      const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<WidgetOptions>({
        moduleName: 'Widget',
      }).build();
      @Module({})
      class WidgetModule extends ConfigurableModuleClass {}

      const a = WidgetModule.register({ color: 'red' });
      const b = WidgetModule.register({ color: 'red' });
      const c = WidgetModule.register({ color: 'blue' });
      expect(a.key).toBe(b.key);
      // No structural fields: a second configuration needs an explicit key.
      expect(c.key).toBe(a.key);
      expect(WidgetModule.register({ color: 'blue', key: 'blue' }).key).toBe('blue');
    });

    it('honors an explicit key and does not leak it into the options bag', () => {
      const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<WidgetOptions>({
        moduleName: 'Widget',
      }).build();
      @Module({})
      class WidgetModule extends ConfigurableModuleClass {}

      const dyn = WidgetModule.register({ color: 'red', key: 'custom' });
      expect(dyn.key).toBe('custom');
      expect(dyn.providers?.[0]).toMatchObject({ useValue: { color: 'red' } });
    });

    it('default isGlobal extra toggles DynamicModule.global without changing the key', () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<WidgetOptions>({
          moduleName: 'Widget',
        }).build();
      @Module({})
      class WidgetModule extends ConfigurableModuleClass {}

      const off = WidgetModule.register({ color: 'red' });
      const on = WidgetModule.register({ color: 'red', isGlobal: true });
      expect(off.global).toBeUndefined();
      expect(on.global).toBe(true);
      expect(off.key).toBe(on.key);
      expect(on.providers).toEqual([
        defineProvider(MODULE_OPTIONS_TOKEN, { useValue: { color: 'red' } }),
      ]);
    });

    it('applies a custom extras transform', () => {
      const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<WidgetOptions>({
        moduleName: 'Widget',
      })
        .setExtras({ tag: 'none' as string }, (def, { tag }) => ({
          ...def,
          key: `${def.key}:${tag}`,
        }))
        .build();
      @Module({})
      class WidgetModule extends ConfigurableModuleClass {}

      const dyn = WidgetModule.register({ color: 'red', tag: 'x' });
      expect(dyn.key?.endsWith(':x')).toBe(true);
    });
  });

  describe('registerAsync', () => {
    it('lowers useFactory into an options provider and passes imports through', () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<WidgetOptions>({
          moduleName: 'Widget',
        }).build();
      @Module({})
      class WidgetModule extends ConfigurableModuleClass {}

      const fn = () => ({ color: 'red' });
      const dyn = WidgetModule.registerAsync({ useFactory: fn, inject: [], imports: [] });
      expect(dyn.module).toBe(WidgetModule);
      expect(dyn.providers).toEqual([
        defineProvider(MODULE_OPTIONS_TOKEN, { useFactory: fn, inject: [] }),
      ]);
      expect(dyn.imports).toEqual([]);
    });

    it('lowers useClass into a factory-class registration + create() provider', () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<WidgetOptions>({
          moduleName: 'Widget',
        }).build();
      @Module({})
      class WidgetModule extends ConfigurableModuleClass {}

      class WidgetOptionsFactory {
        create(): WidgetOptions {
          return { color: 'green' };
        }
      }
      const dyn = WidgetModule.registerAsync({ useClass: WidgetOptionsFactory });
      expect(dyn.providers?.[0]).toBe(WidgetOptionsFactory);
      const optionsProvider = dyn.providers?.[1] as ProviderOptions;
      expect(optionsProvider.provide).toBe(MODULE_OPTIONS_TOKEN);
      expect(optionsProvider.inject).toEqual([WidgetOptionsFactory]);
      expect(optionsProvider.useFactory?.(new WidgetOptionsFactory())).toEqual({ color: 'green' });
    });

    it('lowers useExisting into a create() provider injecting the existing token', () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<WidgetOptions>({
          moduleName: 'Widget',
        }).build();
      @Module({})
      class WidgetModule extends ConfigurableModuleClass {}

      class ExistingFactory {
        create(): WidgetOptions {
          return { color: 'blue' };
        }
      }
      const dyn = WidgetModule.registerAsync({ useExisting: ExistingFactory });
      const optionsProvider = dyn.providers?.[0] as ProviderOptions;
      expect(optionsProvider.provide).toBe(MODULE_OPTIONS_TOKEN);
      expect(optionsProvider.inject).toEqual([ExistingFactory]);
    });
  });

  describe('end-to-end DI', () => {
    it('resolves options + a derived service through the container (register)', async () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<WidgetOptions>({
          moduleName: 'Widget',
        }).build();

      @Injectable()
      class WidgetService {
        constructor(@Inject(MODULE_OPTIONS_TOKEN) readonly options: WidgetOptions) {}
        describe(): string {
          return `${this.options.color}:${this.options.size ?? 0}`;
        }
      }

      @Module({ providers: [WidgetService], exports: [WidgetService] })
      class WidgetModule extends ConfigurableModuleClass {}

      @Module({ imports: [WidgetModule.register({ color: 'red', size: 3 })] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      expect(app.get(WidgetService).describe()).toBe('red:3');
    });

    it('resolves options via registerAsync useFactory with injected deps', async () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<WidgetOptions>({
          moduleName: 'Widget',
        }).build();

      @Injectable()
      class WidgetService {
        constructor(@Inject(MODULE_OPTIONS_TOKEN) readonly options: WidgetOptions) {}
      }

      @Injectable()
      class ColorProvider {
        get(): string {
          return 'purple';
        }
      }

      @Module({ providers: [WidgetService], exports: [WidgetService] })
      class WidgetModule extends ConfigurableModuleClass {}

      @Module({ providers: [ColorProvider], exports: [ColorProvider] })
      class ColorModule {}

      @Module({
        imports: [
          WidgetModule.registerAsync({
            imports: [ColorModule],
            inject: [ColorProvider],
            useFactory: (cp: ColorProvider) => ({ color: cp.get() }),
          }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      expect(app.get(WidgetService).options.color).toBe('purple');
    });

    it('supports multiple instances of the same builder module via explicit keys', async () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<WidgetOptions>({
          moduleName: 'Widget',
        }).build();

      @Injectable()
      class WidgetService {
        constructor(@Inject(MODULE_OPTIONS_TOKEN) readonly options: WidgetOptions) {}
      }

      @Module({ providers: [WidgetService], exports: [WidgetService] })
      class WidgetModule extends ConfigurableModuleClass {}

      const red = WidgetModule.register({ color: 'red', key: 'red' });
      const blue = WidgetModule.register({ color: 'blue', key: 'blue' });
      expect(red.key).not.toBe(blue.key);

      @Module({ imports: [red] })
      class RedFeature {}
      @Module({ imports: [blue] })
      class BlueFeature {}
      @Module({ imports: [RedFeature, BlueFeature, red] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
      expect(app.get(WidgetService).options.color).toBe('red');
      expect(app.getContainer().getOwnerModuleIds(MODULE_OPTIONS_TOKEN)).toHaveLength(2);
    });
  });
});
