import { InjectionToken } from '../container/types';
import type { DynamicModule } from '../registry/types';
import type {
  ConfigurableModuleBuilderOptions,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
  DefineConfigurableModuleSpec,
} from './configurable-module.types';
import { defineModule } from './define-module';
import { stableHash } from './stable-hash';

/**
 * Blessed key-derivation helper for hand-written `forRoot` statics: the one
 * documented way to derive a `DynamicModule.key` from an options bag so
 * identical configurations dedup (HMR-idempotent) and distinct ones coexist.
 * Alias of {@link stableHash} with a module-authoring name.
 */
export const moduleKey: (options: unknown) => string = stableHash;

/**
 * NestJS-parity builder that generates `forRoot`/`forRootAsync` (and `key`,
 * `global`, factory-param inference) from a tiny spec — so a module is just its
 * tokens + options type + service + a `@Module({...})` bag, while vela keeps its
 * encapsulation (`exports`/visibility) and multi-instance `key` dedup.
 *
 * Since 1.11 this is a thin adapter over {@link defineModule} — the single
 * authoring engine. Prefer `defineModule` for new modules: it additionally
 * supports contributions (providers/controllers/imports/exports/global
 * components) computed as functions of the options.
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
  private extrasDefaults: ConfigurableModuleExtras | undefined;
  private extrasTransform: ConfigurableModuleExtrasTransform<ConfigurableModuleExtras> | undefined;

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
    return defineModule<Opts, Extras, MethodKey, FactoryMethodKey>({
      name: this.options.moduleName ?? 'ConfigurableModule',
      optionsToken: this.options.optionsInjectionToken as InjectionToken<Opts> | undefined,
      extras: this.extrasDefaults as Extras | undefined,
      transform: this.extrasTransform as ConfigurableModuleExtrasTransform<Extras> | undefined,
      methodName: this.classMethodName as MethodKey,
      factoryMethodName: this.factoryMethodName as FactoryMethodKey,
    });
  }
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
