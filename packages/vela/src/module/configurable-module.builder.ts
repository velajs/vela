import type { DynamicModule } from '../registry/types';
import type {
  ConfigurableModuleBuilderOptions,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
  DefineConfigurableModuleSpec,
} from './configurable-module.types';
import { defineModule, type DefineModuleSpec } from './define-module';
import { attachModuleIdentity } from './module-identity';
import { stableHash } from './stable-hash';

/**
 * Blessed key-derivation helper for hand-written `forRoot` statics: the one
 * documented way to derive a `DynamicModule.key` from an options bag so
 * identical configurations dedup (HMR-idempotent) and distinct ones coexist.
 * Alias of {@link stableHash} with a module-authoring name.
 */
export const moduleKey: (options: unknown) => string = stableHash;

/** Immutable typed state shared by the fluent builder's returned branches. */
class ConfiguredModuleBuilder<
  Opts,
  MethodKey extends string,
  FactoryMethodKey extends string,
  Extras extends ConfigurableModuleExtras,
> {
  constructor(private readonly spec: DefineModuleSpec<Opts, Extras, MethodKey, FactoryMethodKey>) {}

  setExtras<NewExtras extends ConfigurableModuleExtras>(
    defaults: NewExtras,
    transform: ConfigurableModuleExtrasTransform<NewExtras>,
  ): ConfiguredModuleBuilder<Opts, MethodKey, FactoryMethodKey, NewExtras> {
    return new ConfiguredModuleBuilder({
      ...this.spec,
      extras: { ...defaults },
      transform,
    });
  }

  setClassMethodName<NewMethodKey extends string>(
    name: NewMethodKey,
  ): ConfiguredModuleBuilder<Opts, NewMethodKey, FactoryMethodKey, Extras> {
    return new ConfiguredModuleBuilder({ ...this.spec, methodName: name });
  }

  setFactoryMethodName<NewFactoryMethodKey extends string>(
    name: NewFactoryMethodKey,
  ): ConfiguredModuleBuilder<Opts, MethodKey, NewFactoryMethodKey, Extras> {
    return new ConfiguredModuleBuilder({ ...this.spec, factoryMethodName: name });
  }

  build(): ConfigurableModuleHost<Opts, MethodKey, FactoryMethodKey, Extras> {
    return defineModule(this.spec);
  }
}

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
export class ConfigurableModuleBuilder<Opts> extends ConfiguredModuleBuilder<
  Opts,
  'forRoot',
  'create',
  { isGlobal?: boolean }
> {
  constructor(options: ConfigurableModuleBuilderOptions<Opts> = {}) {
    super({
      name: options.moduleName ?? 'ConfigurableModule',
      optionsToken: options.optionsInjectionToken,
      methodName: 'forRoot',
      factoryMethodName: 'create',
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
      return attachModuleIdentity(definition, args);
    },
  };
}
