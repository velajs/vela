import {
  assertFactoryInject,
  defineProvider,
  InjectionToken,
  type ProviderDefinition,
  type Token,
  type Type,
} from '../container/types';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from '../pipeline/tokens';
import type {
  GuardType,
  PipeType,
  InterceptorType,
  FilterType,
  MiddlewareType,
  DynamicModule,
  ModuleImport,
} from '../registry/types';
import type {
  ConfigurableModuleAsyncOptions,
  ConfigurableModuleAsyncFactory,
  ConfigurableModuleClassType,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
} from './configurable-module.types';
import { attachModuleIdentity } from './module-identity';
import { stableHash } from './stable-hash';

/** The `global:` slot's component groups, lowered to `APP_*` registrations. */
export interface GlobalComponentSlot {
  guards?: GuardType[];
  pipes?: PipeType[];
  interceptors?: InterceptorType[];
  filters?: FilterType[];
  middleware?: MiddlewareType[];
}

/** What a module instance contributes, computed from its call-time options. */
export interface ModuleContributions {
  providers?: Array<Type | ProviderDefinition>;
  controllers?: Type[];
  imports?: ModuleImport[];
  exports?: Token[];
  /**
   * Standardized global-component registration — the one idiom replacing both
   * the `@Module({ providers: [{ provide: APP_GUARD, useExisting: X }] })`
   * pattern and the conditional-push-into-forRoot pattern. Class entries are
   * registered as providers and wired via `useExisting`; instances via `useValue`.
   */
  global?: GlobalComponentSlot;
}

export interface ModuleSetupContext<Opts> {
  /** The options token — derived providers do `inject: [OPTIONS]`. */
  readonly OPTIONS: InjectionToken<Opts>;
  /**
   * Structural options known at call time. For `forRoot` this is the full
   * bag; for `forRootAsync` it is only the structural fields passed alongside
   * the factory (the DI-resolved options exist only at resolution time —
   * read them through `OPTIONS`, never here).
   */
  readonly options: Partial<Opts>;
  /** The instance key in effect (for deriving per-instance token names). */
  readonly key: string;
}

export interface DefineModuleSpec<
  Opts,
  Extras extends ConfigurableModuleExtras = { isGlobal?: boolean },
  MethodKey extends string = 'forRoot',
  FactoryMethodKey extends string = 'create',
> {
  /** Names the generated base class, the minted options token, and diagnostics. */
  name: string;
  /**
   * Reuse an existing options token instead of minting one — critical for
   * migrations so the module's public token keeps its identity.
   */
  optionsToken?: InjectionToken<Opts>;
  /**
   * Structural contributions as a function of the call-time options. Runs at
   * `forRoot`/`forRootAsync` call time, once per module instance.
   */
  setup?: (ctx: ModuleSetupContext<Opts>) => ModuleContributions;
  /**
   * Dedup key from the structural options. Defaults to `stableHash(options)`.
   * Modules whose options carry stateful instances (drivers, registries)
   * should derive from the stable identifying subset — or document that
   * callers pass an explicit `key` for multi-instance setups.
   */
  key?: (options: Partial<Opts>) => string;
  /** Call-site extras defaults (default `{ isGlobal: false }`). */
  extras?: Extras;
  /** Reshape the definition from resolved extras (default: `isGlobal` → `global: true`). */
  transform?: ConfigurableModuleExtrasTransform<Extras>;
  /** Rename the sync static (default `forRoot`); the async static becomes `<name>Async`. */
  methodName?: MethodKey;
  /** Method a `useClass`/`useExisting` options factory must implement (default `create`). */
  factoryMethodName?: FactoryMethodKey;
  /**
   * Default every generated module instance to deferred (first-use)
   * materialization. Call sites can also opt in per instance by passing
   * `lazy: true` alongside the options (recognized like `isGlobal`).
   * See docs/modules.md "Lazy modules".
   */
  lazy?: boolean;
}

const DEFAULT_EXTRAS = { isGlobal: false } as const;
const DEFAULT_TRANSFORM: ConfigurableModuleExtrasTransform<{ isGlobal?: boolean }> = (
  def,
  extras,
) => (extras.isGlobal ? { ...def, global: true } : def);

/** Lower typed component slots before the module's heterogeneous provider list. */
function lowerGlobalSlot(slot: GlobalComponentSlot): Array<Type | ProviderDefinition> {
  const out: Array<Type | ProviderDefinition> = [];
  function append<T>(token: InjectionToken<T>, components: readonly (Type<T> | T)[]): void {
    for (const component of components) {
      if (typeof component === 'function') {
        // Component slots accept constructor classes or instances. The runtime
        // constructor branch is the same reflection boundary as decorators.
        const componentClass = component as Type<T>;
        out.push(componentClass, defineProvider(token, { useExisting: componentClass }));
      } else {
        out.push(defineProvider(token, { useValue: component }));
      }
    }
  }
  append(APP_GUARD, slot.guards ?? []);
  append(APP_PIPE, slot.pipes ?? []);
  append(APP_INTERCEPTOR, slot.interceptors ?? []);
  append(APP_FILTER, slot.filters ?? []);
  append(APP_MIDDLEWARE, slot.middleware ?? []);
  return out;
}

const ASYNC_OPTION_KEYS = new Set([
  'key',
  'imports',
  'inject',
  'useFactory',
  'useClass',
  'useExisting',
]);

/**
 * Generates configurable modules with `forRoot` and
 * `forRootAsync` statics with: `stableHash` key derivation (multi-instance
 * dedup that survives HMR), typed `inject` tuple inference on the async
 * factory, an `isGlobal` extra, and — the piece `ConfigurableModuleBuilder`
 * could not express — providers/controllers/imports/exports/global components
 * computed **as functions of the options**.
 *
 * ```ts
 * const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<CorsOptions>({
 *   name: 'Cors',
 *   setup: ({ OPTIONS }) => ({
 *     providers: [defineProvider(APP_MIDDLEWARE, {
 *       useFactory: (options) => buildCorsMiddleware(options),
 *       inject: [OPTIONS],
 *     })],
 *     exports: [OPTIONS],
 *   }),
 * });
 * export class CorsModule extends ConfigurableModuleClass {}
 * ```
 *
 * `ConfigurableModuleBuilder` remains supported (NestJS parity) and is a thin
 * adapter over this engine.
 */
export function defineModule<
  Opts,
  Extras extends ConfigurableModuleExtras = { isGlobal?: boolean },
  MethodKey extends string = 'forRoot',
  FactoryMethodKey extends string = 'create',
>(
  spec: DefineModuleSpec<Opts, Extras, MethodKey, FactoryMethodKey>,
): ConfigurableModuleHost<Opts, MethodKey, FactoryMethodKey, Extras> {
  const optionsToken = spec.optionsToken ?? new InjectionToken<Opts>(`${spec.name}_MODULE_OPTIONS`);
  const syncName = spec.methodName ?? 'forRoot';
  const asyncName = `${syncName}Async`;
  const factoryMethodName = spec.factoryMethodName ?? 'create';
  const extrasDefaults = (spec.extras ?? DEFAULT_EXTRAS) as ConfigurableModuleExtras;
  const transform = (spec.transform ??
    DEFAULT_TRANSFORM) as ConfigurableModuleExtrasTransform<ConfigurableModuleExtras>;

  const deriveKey = (explicit: string | undefined, structural: Record<string, unknown>): string =>
    explicit ?? spec.key?.(structural as Partial<Opts>) ?? stableHash(structural);

  // Laziness is OR-composed: the spec defaults it, a call site can add it.
  const applyLazy = (definition: DynamicModule, callSiteLazy: unknown): DynamicModule =>
    spec.lazy === true || callSiteLazy === true ? { ...definition, lazy: true } : definition;

  const applyContributions = (
    definition: DynamicModule,
    structural: Record<string, unknown>,
    key: string,
  ): DynamicModule => {
    if (!spec.setup) return definition;
    const contributions = spec.setup({
      OPTIONS: optionsToken,
      options: structural as Partial<Opts>,
      key,
    });
    const providers = [
      ...(definition.providers ?? []),
      ...(contributions.providers ?? []),
      ...(contributions.global ? lowerGlobalSlot(contributions.global) : []),
    ];
    return {
      ...definition,
      providers,
      controllers: [...(definition.controllers ?? []), ...(contributions.controllers ?? [])],
      imports: [...(definition.imports ?? []), ...(contributions.imports ?? [])],
      exports: [...(definition.exports ?? []), ...(contributions.exports ?? [])],
    };
  };

  class GeneratedModuleClass {}
  Object.defineProperty(GeneratedModuleClass, 'name', { value: `${spec.name}ModuleHost` });

  Object.defineProperty(GeneratedModuleClass, syncName, {
    configurable: true,
    writable: true,
    enumerable: false,
    value(this: unknown, options: Record<string, unknown> = {}): DynamicModule {
      const { key: explicitKey, ...rest } = options;
      const key = deriveKey(explicitKey as string | undefined, rest);
      const definition: DynamicModule = {
        module: this as DynamicModule['module'],
        key,
        providers: [defineProvider(optionsToken, { useValue: rest as Opts })],
      };
      return attachModuleIdentity(
        applyLazy(
          transform(applyContributions(definition, rest, key), {
            ...extrasDefaults,
            ...rest,
          }),
          rest.lazy,
        ),
        rest,
      );
    },
  });

  Object.defineProperty(GeneratedModuleClass, asyncName, {
    configurable: true,
    writable: true,
    enumerable: false,
    value(
      this: unknown,
      options: ConfigurableModuleAsyncOptions<Opts, FactoryMethodKey>,
    ): DynamicModule {
      const bag = options as ConfigurableModuleAsyncOptions<Opts, FactoryMethodKey> &
        Record<string, unknown>;
      const { key: _explicitKey, ...inputs } = bag;
      const structural: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(bag)) {
        if (!ASYNC_OPTION_KEYS.has(k)) structural[k] = v;
      }
      const key = deriveKey(
        bag.key,
        // Async factories aren't structurally hashable in a useful way, so the
        // default key hashes the async wiring + structural fields — same
        // instance-identity semantics ConfigurableModuleBuilder always had.
        spec.key
          ? structural
          : {
              inject: bag.inject,
              useFactory: bag.useFactory,
              useClass: bag.useClass,
              useExisting: bag.useExisting,
              ...structural,
            },
      );
      const definition: DynamicModule = {
        module: this as DynamicModule['module'],
        key,
        imports: bag.imports ?? [],
        providers: buildAsyncOptionsProviders<Opts, string>(
          optionsToken,
          factoryMethodName,
          bag,
          structural,
        ),
      };
      return attachModuleIdentity(
        applyLazy(
          transform(applyContributions(definition, structural, key), {
            ...extrasDefaults,
            ...structural,
          }),
          structural.lazy,
        ),
        inputs,
      );
    },
  });

  return {
    ConfigurableModuleClass: GeneratedModuleClass as unknown as ConfigurableModuleClassType<
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

/**
 * Lower `useFactory`/`useClass`/`useExisting` async options into provider
 * registrations. Structural fields from the call site merge UNDER the resolved
 * options (`{ ...structural, ...resolved }`) so sync-declared fields act as
 * defaults and the factory stays authoritative.
 */
function buildAsyncOptionsProviders<Opts, MethodKey extends string>(
  optionsToken: InjectionToken<Opts>,
  factoryMethodName: MethodKey,
  async: Pick<
    ConfigurableModuleAsyncFactory<Opts, MethodKey>,
    'inject' | 'useFactory' | 'useClass' | 'useExisting'
  >,
  structural: Record<string, unknown> = {},
): Array<Type | ProviderDefinition> {
  const hasStructural = Object.keys(structural).length > 0;
  const merge = (resolved: Opts | Promise<Opts>): Opts | Promise<Opts> =>
    resolved instanceof Promise
      ? resolved.then((o) => ({ ...structural, ...o }) as Opts)
      : ({ ...structural, ...resolved } as Opts);

  if (async.useFactory) {
    const factory = async.useFactory;
    assertFactoryInject(optionsToken, factory, async.inject);
    return [
      defineProvider(optionsToken, {
        useFactory: hasStructural ? (...deps: unknown[]) => merge(factory(...deps)) : factory,
        inject: async.inject ?? [],
      }),
    ];
  }
  if (async.useClass) {
    const factoryClass = async.useClass;
    return [
      factoryClass,
      defineProvider(optionsToken, {
        useFactory: (instance) => merge(instance[factoryMethodName]()),
        inject: [factoryClass],
      }),
    ];
  }
  if (async.useExisting) {
    return [
      defineProvider(optionsToken, {
        useFactory: (instance) => merge(instance[factoryMethodName]()),
        inject: [async.useExisting],
      }),
    ];
  }
  throw new Error(
    'Async module options require one of `useFactory`, `useClass`, or `useExisting`.',
  );
}
