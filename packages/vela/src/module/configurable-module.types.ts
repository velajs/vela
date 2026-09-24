import type { InferTokens, InjectionToken, Token, Type, FactoryInject } from '../container/types';
import type { DynamicModule, ModuleImport } from '../registry/types';

/**
 * Arbitrary extra keys a module accepts alongside its options bag (e.g.
 * `isGlobal`). Kept separate from the options type so the extras-transform can
 * reshape the generated {@link DynamicModule} without polluting `Opts`: extras
 * never reach the options token and never change the instance key.
 */
export type ConfigurableModuleExtras = Record<string, unknown>;

/** Controls shared by synchronous and asynchronous module registrations. */
export interface ModuleRegistrationOptions {
  /** Names the instance explicitly; identical `(class, key)` imports are one instance. */
  key?: string;
  /** Defer the instance to first use (see {@link DynamicModule.lazy}). */
  lazy?: boolean;
}

/**
 * What an asynchronous options factory returns: the options minus the
 * structural fields `S`, which the call site supplies (a returned structural
 * field fails to compile). Distributes over a union of option shapes.
 */
export type ModuleFactoryOptions<Opts, S extends keyof Opts = never> = [S] extends [never]
  ? Opts
  : Opts extends unknown
    ? Omit<Opts, S> & Partial<Record<S, never>>
    : never;

/**
 * Reshape the generated definition based on the resolved extras. Runs after the
 * options provider + `key` are computed; the return value is the final
 * `DynamicModule`. Mirrors NestJS's `extras` transform.
 */
export type ConfigurableModuleExtrasTransform<E extends ConfigurableModuleExtras> = (
  definition: DynamicModule,
  extras: E,
) => DynamicModule;

/**
 * The contract a `useClass`/`useExisting` async-options factory must satisfy:
 * a single method (default name `create`) returning the module options.
 */
export type ConfigurableModuleOptionsFactory<Opts, MethodName extends string> = {
  [K in MethodName]: () => Opts | Promise<Opts>;
};

/**
 * Async configuration accepted by the generated `<method>Async` static: the
 * structural fields `Pick<Opts, S>` at the call site, and a factory that
 * returns the rest (`Omit<Opts, S>`). The `const Inject` tuple infers the
 * `useFactory` parameters (no `as const` needed at the call site).
 */
export type ConfigurableModuleAsyncOptions<
  Opts,
  S extends keyof Opts = never,
  MethodName extends string = 'create',
  Inject extends readonly Token[] = readonly Token[],
> = {
  imports?: ModuleImport[];
} & ModuleRegistrationOptions &
  Pick<Opts, S> &
  ConfigurableModuleAsyncFactory<ModuleFactoryOptions<Opts, S>, MethodName, Inject>;

/** DI factory alternatives kept separate from call-time structural options. */
export type ConfigurableModuleAsyncFactory<
  Opts,
  MethodName extends string,
  Inject extends readonly Token[] = readonly Token[],
> =
  | ({
      useFactory: (...args: InferTokens<Inject>) => Opts | Promise<Opts>;
      useClass?: never;
      useExisting?: never;
    } & FactoryInject<Inject>)
  | {
      useClass: Type<ConfigurableModuleOptionsFactory<Opts, MethodName>>;
      useFactory?: never;
      useExisting?: never;
      inject?: never;
    }
  | {
      useExisting:
        | InjectionToken<ConfigurableModuleOptionsFactory<Opts, MethodName>>
        | Type<ConfigurableModuleOptionsFactory<Opts, MethodName>>;
      useFactory?: never;
      useClass?: never;
      inject?: never;
    };

export interface ConfigurableModuleBuilderOptions<Opts = unknown> {
  /** Names the generated base class + the auto-minted options token, and feeds diagnostics. */
  moduleName?: string;
  /**
   * Reuse an existing options token instead of minting one. **Critical for
   * migrations** so the module's public token keeps its identity.
   */
  optionsInjectionToken?: InjectionToken<Opts>;
}

/** The synchronous static's options: optional when every option is. */
type SyncOptionsArgs<Opts, Extras extends ConfigurableModuleExtras> = {} extends Opts
  ? [options?: Opts & Partial<Extras> & ModuleRegistrationOptions]
  : [options: Opts & Partial<Extras> & ModuleRegistrationOptions];

/**
 * The generated base class type, carrying dynamically-named `<method>` and
 * `<method>Async` statics. A module does `class Foo extends ConfigurableModuleClass {}`
 * and gets `Foo.forRoot(...)` / `Foo.forRootAsync(...)` for free.
 */
export type ConfigurableModuleClassType<
  Opts,
  MethodKey extends string,
  FactoryMethodKey extends string,
  Extras extends ConfigurableModuleExtras,
  S extends keyof Opts = never,
> = (new () => object) &
  Record<MethodKey, (...options: SyncOptionsArgs<Opts, Extras>) => DynamicModule> &
  Record<
    `${MethodKey}Async`,
    <const Inject extends readonly Token[]>(
      options: ConfigurableModuleAsyncOptions<Opts, S, FactoryMethodKey, Inject> & Partial<Extras>,
    ) => DynamicModule
  >;

export interface ConfigurableModuleHost<
  Opts,
  MethodKey extends string = 'forRoot',
  FactoryMethodKey extends string = 'create',
  Extras extends ConfigurableModuleExtras = { isGlobal?: boolean },
  S extends keyof Opts = never,
> {
  /** Base class to `extends`. */
  ConfigurableModuleClass: ConfigurableModuleClassType<
    Opts,
    MethodKey,
    FactoryMethodKey,
    Extras,
    S
  >;
  /** The options token — inject it into derived providers (`inject: [MODULE_OPTIONS_TOKEN]`). */
  MODULE_OPTIONS_TOKEN: InjectionToken<Opts>;
  /** Type-only helper: the shape accepted by the sync `<method>` static. */
  OPTIONS_TYPE: Opts & Partial<Extras> & ModuleRegistrationOptions;
  /** Type-only helper: the shape accepted by the `<method>Async` static. */
  ASYNC_OPTIONS_TYPE: ConfigurableModuleAsyncOptions<Opts, S, FactoryMethodKey> & Partial<Extras>;
}
