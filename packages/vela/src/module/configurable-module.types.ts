import type { InferTokens, InjectionToken, Token, Type } from '../container/types';
import type { DynamicModule, ModuleImport } from '../registry/types';

/**
 * Arbitrary extra keys a module accepts alongside its options bag (e.g.
 * `isGlobal`). Kept separate from the options type so the extras-transform can
 * reshape the generated {@link DynamicModule} without polluting `Opts`.
 */
export type ConfigurableModuleExtras = Record<string, unknown>;

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
 * Async configuration accepted by the generated `<method>Async` static.
 *
 * Superset of `AsyncModuleOptions` (`registry/types.ts`): adds NestJS's
 * `useClass`/`useExisting` while preserving the headline `const Inject` tuple
 * inference for `useFactory` params (no `as const` needed at the call site).
 */
export type ConfigurableModuleAsyncOptions<
  Opts,
  MethodName extends string = 'create',
  Inject extends readonly Token[] = readonly Token[],
> = {
  imports?: ModuleImport[];
  /** Explicit instance discriminator (see {@link DynamicModule.key}). */
  key?: string;
} & (
  | {
      inject: Inject;
      useFactory: (...args: InferTokens<Inject>) => Opts | Promise<Opts>;
      useClass?: never;
      useExisting?: never;
    }
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
    }
);

export interface ConfigurableModuleBuilderOptions<Opts = unknown> {
  /** Names the generated base class + the auto-minted options token, and feeds diagnostics. */
  moduleName?: string;
  /**
   * Reuse an existing options token instead of minting one. **Critical for
   * migrations** so the module's public token keeps its identity.
   */
  optionsInjectionToken?: InjectionToken<Opts>;
}

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
> = (new () => object) &
  Record<MethodKey, (options: Opts & Partial<Extras> & { key?: string }) => DynamicModule> &
  Record<
    `${MethodKey}Async`,
    <const Inject extends readonly Token[]>(
      options: ConfigurableModuleAsyncOptions<Opts, FactoryMethodKey, Inject> &
        Partial<Extras> & { key?: string },
    ) => DynamicModule
  >;

export interface ConfigurableModuleHost<
  Opts,
  MethodKey extends string = 'forRoot',
  FactoryMethodKey extends string = 'create',
  Extras extends ConfigurableModuleExtras = { isGlobal?: boolean },
> {
  /** Base class to `extends`. */
  ConfigurableModuleClass: ConfigurableModuleClassType<Opts, MethodKey, FactoryMethodKey, Extras>;
  /** The options token — inject it into derived providers (`inject: [MODULE_OPTIONS_TOKEN]`). */
  MODULE_OPTIONS_TOKEN: InjectionToken<Opts>;
  /** Type-only helper: the shape accepted by the sync `<method>` static. */
  OPTIONS_TYPE: Opts & Partial<Extras> & { key?: string };
  /** Type-only helper: the shape accepted by the `<method>Async` static. */
  ASYNC_OPTIONS_TYPE: ConfigurableModuleAsyncOptions<Opts, FactoryMethodKey> &
    Partial<Extras> & { key?: string };
}

/**
 * Low-level engine spec (see `defineConfigurableModule`). Used for the cases a
 * class-mixin can't express — notably runtime-generated module classes whose
 * providers depend on a call-time argument (e.g. Cloudflare binding modules).
 */
export interface DefineConfigurableModuleSpec<Args> {
  /** The module class to reference in `{ module }`. */
  module: Type;
  /** Static method name to generate (e.g. `forRoot`). */
  methodName?: string;
  /** Derive the instance `key` from the call args. */
  keyFrom: (args: Args) => string;
  /** Build the provider list from the call args. */
  providers: (args: Args) => DynamicModule['providers'];
  /** Optional exports (usually prefer declaring these on `@Module`). */
  exports?: DynamicModule['exports'];
  /** Optional imports. */
  imports?: (args: Args) => DynamicModule['imports'];
  /** Mark the produced module global. */
  global?: boolean;
}
