import { InjectionToken, type ProviderOptions, type Token } from '../container/types';
import type { DynamicModule } from '../registry/types';
import type {
  ConfigurableModuleAsyncOptions,
  ConfigurableModuleBuilderOptions,
  ConfigurableModuleClassType,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
  DefineConfigurableModuleSpec,
} from './configurable-module.types';
import { stableHash } from './stable-hash';

/** Default extra: `isGlobal` toggles `DynamicModule.global`, hiding the naming split. */
const DEFAULT_EXTRAS = { isGlobal: false } as const;
const DEFAULT_TRANSFORM: ConfigurableModuleExtrasTransform<{ isGlobal?: boolean }> = (def, extras) =>
  extras.isGlobal ? { ...def, global: true } : def;

/**
 * NestJS-parity builder that generates `forRoot`/`forRootAsync` (and `key`,
 * `global`, factory-param inference) from a tiny spec — so a module is just its
 * tokens + options type + service + a `@Module({...})` bag, while vela keeps its
 * encapsulation (`exports`/visibility) and multi-instance `key` dedup.
 *
 * @example
 * ```ts
 * const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
 *   new ConfigurableModuleBuilder<FooOptions>({ moduleName: 'Foo' }).build();
 *
 * @Module({
 *   providers: [FooService], // derived providers inject MODULE_OPTIONS_TOKEN
 *   exports: [FooService],
 * })
 * export class FooModule extends ConfigurableModuleClass {}
 * ```
 */
export class ConfigurableModuleBuilder<
  Opts,
  MethodKey extends string = 'forRoot',
  FactoryMethodKey extends string = 'create',
  Extras extends ConfigurableModuleExtras = { isGlobal?: boolean },
> {
  private classMethodName = 'forRoot';
  private factoryMethodName = 'create';
  private extrasDefaults: ConfigurableModuleExtras = DEFAULT_EXTRAS;
  private extrasTransform: ConfigurableModuleExtrasTransform<ConfigurableModuleExtras> =
    DEFAULT_TRANSFORM as ConfigurableModuleExtrasTransform<ConfigurableModuleExtras>;

  constructor(private readonly options: ConfigurableModuleBuilderOptions = {}) {}

  /** Declare extra call-site keys (e.g. `isGlobal`) + how they reshape the definition. */
  setExtras<NewExtras extends ConfigurableModuleExtras>(
    defaults: NewExtras,
    transform: ConfigurableModuleExtrasTransform<NewExtras>,
  ): ConfigurableModuleBuilder<Opts, MethodKey, FactoryMethodKey, NewExtras> {
    this.extrasDefaults = defaults;
    this.extrasTransform = transform as ConfigurableModuleExtrasTransform<ConfigurableModuleExtras>;
    return this as unknown as ConfigurableModuleBuilder<Opts, MethodKey, FactoryMethodKey, NewExtras>;
  }

  /** Rename the sync static (default `forRoot`); the async static becomes `<name>Async`. */
  setClassMethodName<NewMethodKey extends string>(
    name: NewMethodKey,
  ): ConfigurableModuleBuilder<Opts, NewMethodKey, FactoryMethodKey, Extras> {
    this.classMethodName = name;
    return this as unknown as ConfigurableModuleBuilder<Opts, NewMethodKey, FactoryMethodKey, Extras>;
  }

  /** Rename the method a `useClass`/`useExisting` options factory must implement (default `create`). */
  setFactoryMethodName<NewFactoryMethodKey extends string>(
    name: NewFactoryMethodKey,
  ): ConfigurableModuleBuilder<Opts, MethodKey, NewFactoryMethodKey, Extras> {
    this.factoryMethodName = name;
    return this as unknown as ConfigurableModuleBuilder<Opts, MethodKey, NewFactoryMethodKey, Extras>;
  }

  build(): ConfigurableModuleHost<Opts, MethodKey, FactoryMethodKey, Extras> {
    const moduleName = this.options.moduleName ?? 'ConfigurableModule';
    const optionsToken =
      (this.options.optionsInjectionToken as InjectionToken<Opts> | undefined) ??
      new InjectionToken<Opts>(`${moduleName}_MODULE_OPTIONS`);
    const syncName = this.classMethodName;
    const asyncName = `${this.classMethodName}Async`;
    const factoryMethodName = this.factoryMethodName;
    const extrasDefaults = this.extrasDefaults;
    const transform = this.extrasTransform;

    class ConfigurableModuleClass {}

    Object.defineProperty(ConfigurableModuleClass, syncName, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(this: unknown, options: Record<string, unknown> = {}): DynamicModule {
        const { key, ...rest } = options;
        const definition: DynamicModule = {
          module: this as DynamicModule['module'],
          key: (key as string | undefined) ?? stableHash(rest),
          providers: [{ provide: optionsToken as Token, useValue: rest }],
        };
        return transform(definition, { ...extrasDefaults, ...rest });
      },
    });

    Object.defineProperty(ConfigurableModuleClass, asyncName, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(this: unknown, options: ConfigurableModuleAsyncOptions<Opts> = {}): DynamicModule {
        const { key, imports, inject, useFactory, useClass, useExisting, ...restExtras } =
          options as ConfigurableModuleAsyncOptions<Opts> & Record<string, unknown>;
        const definition: DynamicModule = {
          module: this as DynamicModule['module'],
          // Include extras (e.g. isGlobal) in the key — like forRoot — so two
          // async instances differing only in an extra don't wrongly dedup.
          key:
            (key as string | undefined) ??
            stableHash({ inject, useFactory, useClass, useExisting, ...restExtras }),
          imports: imports ?? [],
          providers: buildAsyncOptionsProviders(
            optionsToken as Token,
            factoryMethodName,
            { inject, useFactory, useClass, useExisting },
          ),
        };
        return transform(definition, { ...extrasDefaults, ...restExtras });
      },
    });

    return {
      ConfigurableModuleClass: ConfigurableModuleClass as unknown as ConfigurableModuleClassType<
        Opts,
        MethodKey,
        FactoryMethodKey,
        Extras
      >,
      MODULE_OPTIONS_TOKEN: optionsToken,
      // Type-only sentinels — never read at runtime.
      OPTIONS_TYPE: undefined as never,
      ASYNC_OPTIONS_TYPE: undefined as never,
    };
  }
}

/** Lower `useFactory`/`useClass`/`useExisting` async options into provider registrations. */
function buildAsyncOptionsProviders<Opts>(
  optionsToken: Token,
  factoryMethodName: string,
  async: Pick<ConfigurableModuleAsyncOptions<Opts>, 'inject' | 'useFactory' | 'useClass' | 'useExisting'>,
): Array<ProviderOptions> {
  if (async.useFactory) {
    return [{ provide: optionsToken, useFactory: async.useFactory, inject: async.inject ?? [] }];
  }
  if (async.useClass) {
    const factoryClass = async.useClass;
    return [
      factoryClass as unknown as ProviderOptions,
      {
        provide: optionsToken,
        useFactory: (instance: Record<string, () => unknown>) => instance[factoryMethodName](),
        inject: [factoryClass as unknown as Token],
      },
    ];
  }
  if (async.useExisting) {
    return [
      {
        provide: optionsToken,
        useFactory: (instance: Record<string, () => unknown>) => instance[factoryMethodName](),
        inject: [async.useExisting as unknown as Token],
      },
    ];
  }
  throw new Error(
    'Async module options require one of `useFactory`, `useClass`, or `useExisting`.',
  );
}

/**
 * Lower-level engine for cases a class-mixin can't express — chiefly a
 * runtime-generated module class whose providers depend on a call-time arg
 * (Cloudflare binding modules). Returns an object with a single static named by
 * `spec.methodName` (default `forRoot`).
 */
export function defineConfigurableModule<Args>(
  spec: DefineConfigurableModuleSpec<Args>,
): Record<string, (args: Args) => DynamicModule> {
  const methodName = spec.methodName ?? 'forRoot';
  return {
    [methodName](args: Args): DynamicModule {
      const definition: DynamicModule = {
        module: spec.module,
        key: spec.keyFrom(args),
        providers: spec.providers(args),
      };
      if (spec.imports) definition.imports = spec.imports(args);
      if (spec.exports) definition.exports = spec.exports;
      if (spec.global) definition.global = true;
      return definition;
    },
  };
}
