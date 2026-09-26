import type {
  ConfigurableModuleBuilderOptions,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
} from './configurable-module.types';
import { defineModule, type DefineModuleSpec } from './define-module';

/** Immutable typed state shared by the fluent builder's returned branches. */
class ConfiguredModuleBuilder<
  Opts,
  MethodKey extends string,
  FactoryMethodKey extends string,
  Extras extends ConfigurableModuleExtras,
> {
  constructor(
    private readonly spec: DefineModuleSpec<Opts, never, Extras, MethodKey, FactoryMethodKey>,
  ) {}

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
 * NestJS-shaped facade over {@link defineModule}: it generates Nest's
 * `register`/`registerAsync` statics (rename them with `setClassMethodName`),
 * an `isGlobal` extra and factory-parameter inference, while the module keeps
 * Vela's encapsulation and `(class, key)` instance identity. First-party
 * modules use `defineModule`, which generates `forRoot`/`forRootAsync` and
 * computes contributions from structural options.
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
 * // FooModule.register({ ... }) / FooModule.registerAsync({ useFactory })
 * ```
 */
export class ConfigurableModuleBuilder<Opts> extends ConfiguredModuleBuilder<
  Opts,
  'register',
  'create',
  { isGlobal?: boolean }
> {
  constructor(options: ConfigurableModuleBuilderOptions<Opts> = {}) {
    super({
      name: options.moduleName ?? 'ConfigurableModule',
      identity: options.identity ?? 'registration',
      optionsToken: options.optionsInjectionToken,
      methodName: 'register',
      factoryMethodName: 'create',
    });
  }
}
