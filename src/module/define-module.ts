import { InjectionToken, type ProviderOptions, type Token, type Type } from '../container/types';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from '../pipeline/tokens';
import type { ComponentInstance, DynamicModule, ModuleImport } from '../registry/types';
import type {
  ConfigurableModuleAsyncOptions,
  ConfigurableModuleClassType,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
} from './configurable-module.types';
import { stableHash } from './stable-hash';

/** The `global:` slot's component groups, lowered to `APP_*` registrations. */
export interface GlobalComponentSlot {
  guards?: Array<Type | ComponentInstance>;
  pipes?: Array<Type | ComponentInstance>;
  interceptors?: Array<Type | ComponentInstance>;
  filters?: Array<Type | ComponentInstance>;
  middleware?: Array<Type | ComponentInstance>;
}

/** What a module instance contributes, computed from its call-time options. */
export interface ModuleContributions {
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  imports?: ModuleImport[];
  exports?: Array<Type | InjectionToken>;
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
}

const DEFAULT_EXTRAS = { isGlobal: false } as const;
const DEFAULT_TRANSFORM: ConfigurableModuleExtrasTransform<{ isGlobal?: boolean }> = (
  def,
  extras,
) => (extras.isGlobal ? { ...def, global: true } : def);

const GLOBAL_SLOT_TOKENS = {
  guards: APP_GUARD,
  pipes: APP_PIPE,
  interceptors: APP_INTERCEPTOR,
  filters: APP_FILTER,
  middleware: APP_MIDDLEWARE,
} as const;

/** Lower a `global:` slot to `APP_*` provider registrations. */
function lowerGlobalSlot(slot: GlobalComponentSlot): Array<Type | ProviderOptions> {
  const out: Array<Type | ProviderOptions> = [];
  for (const kind of Object.keys(GLOBAL_SLOT_TOKENS) as Array<keyof GlobalComponentSlot>) {
    for (const component of slot[kind] ?? []) {
      const token = GLOBAL_SLOT_TOKENS[kind];
      if (typeof component === 'function') {
        out.push(component as Type, { provide: token, useExisting: component as Token });
      } else {
        out.push({ provide: token, useValue: component });
      }
    }
  }
  return out;
}

const ASYNC_OPTION_KEYS = new Set(['key', 'imports', 'inject', 'useFactory', 'useClass', 'useExisting']);

/**
 * The one blessed module-authoring engine. Generates `forRoot` AND
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
 *     providers: [{
 *       provide: APP_MIDDLEWARE,
 *       useFactory: (o: CorsOptions) => buildCorsMiddleware(o),
 *       inject: [OPTIONS],
 *     }],
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
  const optionsToken =
    spec.optionsToken ?? new InjectionToken<Opts>(`${spec.name}_MODULE_OPTIONS`);
  const syncName = spec.methodName ?? 'forRoot';
  const asyncName = `${syncName}Async`;
  const factoryMethodName = spec.factoryMethodName ?? 'create';
  const extrasDefaults = (spec.extras ?? DEFAULT_EXTRAS) as ConfigurableModuleExtras;
  const transform = (spec.transform ??
    DEFAULT_TRANSFORM) as ConfigurableModuleExtrasTransform<ConfigurableModuleExtras>;

  const deriveKey = (explicit: string | undefined, structural: Record<string, unknown>): string =>
    explicit ?? spec.key?.(structural as Partial<Opts>) ?? stableHash(structural);

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
        providers: [{ provide: optionsToken as Token, useValue: rest }],
      };
      return transform(applyContributions(definition, rest, key), {
        ...extrasDefaults,
        ...rest,
      });
    },
  });

  Object.defineProperty(GeneratedModuleClass, asyncName, {
    configurable: true,
    writable: true,
    enumerable: false,
    value(this: unknown, options: ConfigurableModuleAsyncOptions<Opts> = {}): DynamicModule {
      const bag = options as ConfigurableModuleAsyncOptions<Opts> & Record<string, unknown>;
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
        providers: buildAsyncOptionsProviders<Opts>(
          optionsToken as Token,
          factoryMethodName,
          bag,
          structural,
        ),
      };
      return transform(applyContributions(definition, structural, key), {
        ...extrasDefaults,
        ...structural,
      });
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
export function buildAsyncOptionsProviders<Opts>(
  optionsToken: Token,
  factoryMethodName: string,
  async: Pick<
    ConfigurableModuleAsyncOptions<Opts>,
    'inject' | 'useFactory' | 'useClass' | 'useExisting'
  >,
  structural: Record<string, unknown> = {},
): Array<ProviderOptions> {
  const hasStructural = Object.keys(structural).length > 0;
  const merge = (resolved: Opts | Promise<Opts>): Opts | Promise<Opts> =>
    resolved instanceof Promise
      ? resolved.then((o) => ({ ...structural, ...o }) as Opts)
      : ({ ...structural, ...resolved } as Opts);

  if (async.useFactory) {
    const factory = async.useFactory;
    return [
      {
        provide: optionsToken,
        // No structural fields → pass the caller's factory through untouched
        // (function identity preserved; nothing to merge).
        useFactory: hasStructural
          ? (...deps: unknown[]) =>
              merge((factory as (...a: unknown[]) => Opts | Promise<Opts>)(...deps))
          : (factory as (...deps: unknown[]) => Opts | Promise<Opts>),
        inject: (async.inject ?? []) as Token[],
      },
    ];
  }
  if (async.useClass) {
    const factoryClass = async.useClass;
    return [
      factoryClass as unknown as ProviderOptions,
      {
        provide: optionsToken,
        useFactory: (instance: Record<string, () => Opts | Promise<Opts>>) =>
          merge(instance[factoryMethodName]()),
        inject: [factoryClass as unknown as Token],
      },
    ];
  }
  if (async.useExisting) {
    return [
      {
        provide: optionsToken,
        useFactory: (instance: Record<string, () => Opts | Promise<Opts>>) =>
          merge(instance[factoryMethodName]()),
        inject: [async.useExisting as unknown as Token],
      },
    ];
  }
  throw new Error(
    'Async module options require one of `useFactory`, `useClass`, or `useExisting`.',
  );
}
