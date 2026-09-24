import {
  assertFactoryInject,
  defineProvider,
  InjectionToken,
  type Provider,
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
  ConfigurableModuleAsyncFactory,
  ConfigurableModuleClassType,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
} from './configurable-module.types';
import { attachModuleIdentity } from './module-fingerprints';
import { stableHash } from './stable-hash';

/** The `global:` slot's component groups, lowered to `APP_*` registrations. */
export interface GlobalComponentSlot {
  guards?: GuardType[];
  pipes?: PipeType[];
  interceptors?: InterceptorType[];
  filters?: FilterType[];
  middleware?: MiddlewareType[];
}

/** What a module instance contributes, computed from its structural options. */
export interface ModuleContributions {
  /** Classes, definitions and literals; the module loader checks literals when it loads. */
  providers?: Provider[];
  controllers?: Type[];
  imports?: ModuleImport[];
  exports?: Token[];
  /**
   * App-wide components contributed by this module instance, lowered to
   * `APP_*` providers. Class entries are registered as providers and wired
   * via `useExisting`; instances via `useValue`. Conditional entries need no
   * separate `{ provide: APP_GUARD, ... }` push into `providers`.
   */
  global?: GlobalComponentSlot;
}

export interface ModuleSetupContext<Opts, S extends keyof Opts = never> {
  /** The options token — derived providers do `inject: [OPTIONS]`. */
  readonly OPTIONS: InjectionToken<Opts>;
  /**
   * The structural options: the fields the spec declares in `structural`,
   * which `forRoot` and `forRootAsync` both take at the call site. Every other
   * option exists only once DI resolves `OPTIONS`; read it there.
   */
  readonly options: Pick<Opts, S>;
  /** The instance key in effect (for deriving per-instance token names). */
  readonly key: string;
}

export interface DefineModuleSpec<
  Opts,
  S extends keyof Opts = never,
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
   * The option fields `setup` and `key` read. They shape the module graph, so
   * `forRoot` and `forRootAsync` both take them at the call site, and an async
   * factory returns only the other fields. List every member of `S`:
   * `forRootAsync` rejects a call-site option this list leaves out.
   */
  structural?: readonly S[];
  /**
   * Contributions as a function of the structural options. Runs at
   * `forRoot`/`forRootAsync` call time, once per module instance.
   */
  setup?: (ctx: ModuleSetupContext<Opts, S>) => ModuleContributions;
  /**
   * Instance key from the structural options. Defaults to
   * `stableHash(structural)`, so a module without structural fields has one
   * instance per class unless the caller passes an explicit `key`. Use
   * `referenceKey` to key stateful structural values by reference. A module
   * that takes no options and is also imported bare (an `@Module` class with
   * its own providers) returns `'default'`, the bare import's key, so
   * `forRoot()` and the class are one instance.
   */
  key?: (options: Pick<Opts, S>) => string;
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
   * `lazy: true` alongside the options. See docs/modules.md "Lazy modules".
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

/**
 * Split a call-site bag into the named fields and everything else, keeping
 * enumerable symbol-keyed options with the rest.
 */
function split(
  bag: object,
  names: ReadonlySet<string>,
): [picked: Record<PropertyKey, unknown>, rest: Record<PropertyKey, unknown>] {
  const picked: Record<PropertyKey, unknown> = {};
  const rest: Record<PropertyKey, unknown> = {};
  for (const name of Reflect.ownKeys(bag)) {
    if (!Object.prototype.propertyIsEnumerable.call(bag, name)) continue;
    const value: unknown = Reflect.get(bag, name);
    if (typeof name === 'string' && names.has(name)) picked[name] = value;
    else rest[name] = value;
  }
  return [picked, rest];
}

/** The bag without its `undefined` fields: an explicit `undefined` means "not given". */
function defined(bag: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> {
  const out: Record<PropertyKey, unknown> = {};
  for (const name of Reflect.ownKeys(bag)) {
    if (bag[name] !== undefined) out[name] = bag[name];
  }
  return out;
}

const REGISTRATION_KEYS: ReadonlySet<string> = new Set(['key', 'lazy']);
const ASYNC_WIRING_KEYS: ReadonlySet<string> = new Set([
  'imports',
  'inject',
  'useFactory',
  'useClass',
  'useExisting',
]);

/**
 * Generates configurable modules with `forRoot` and `forRootAsync` statics:
 * instance keys from the declared structural options, typed `inject` tuple
 * inference on the async factory, an `isGlobal` extra, and contributions
 * (providers/controllers/imports/exports/global components) computed from the
 * structural options.
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
 * `key`, `lazy` and the extras (such as `isGlobal`) are registration controls:
 * they never reach the options token and never change the instance key. The
 * module loader rejects a repeated `(class, key)` import built from different
 * inputs. `ConfigurableModuleBuilder` is a Nest-shaped facade over this engine.
 */
export function defineModule<
  Opts,
  S extends keyof Opts = never,
  Extras extends ConfigurableModuleExtras = { isGlobal?: boolean },
  MethodKey extends string = 'forRoot',
  FactoryMethodKey extends string = 'create',
>(
  spec: DefineModuleSpec<Opts, S, Extras, MethodKey, FactoryMethodKey>,
): ConfigurableModuleHost<Opts, MethodKey, FactoryMethodKey, Extras, S> {
  const optionsToken = spec.optionsToken ?? new InjectionToken<Opts>(`${spec.name}_MODULE_OPTIONS`);
  const syncName = spec.methodName ?? 'forRoot';
  const asyncName = `${syncName}Async`;
  const factoryMethodName = spec.factoryMethodName ?? 'create';
  const extrasDefaults: ConfigurableModuleExtras = spec.extras ?? DEFAULT_EXTRAS;
  const extrasKeys: ReadonlySet<string> = new Set(Object.keys(extrasDefaults));
  const structuralKeys: ReadonlySet<string> = new Set((spec.structural ?? []).map(String));
  const transform = (spec.transform ??
    DEFAULT_TRANSFORM) as ConfigurableModuleExtrasTransform<ConfigurableModuleExtras>;
  // The default transform reads `isGlobal` only for the definition's `global`
  // flag, which the module loader compares on its own; a repeat that differs
  // only there is reported, not rejected. A custom transform may read any
  // extra for anything, so each one it receives is an identity input.
  const identityExtras = spec.transform
    ? (extras: ConfigurableModuleExtras) => extras
    : ({ isGlobal: _visibility, ...extras }: ConfigurableModuleExtras) => extras;

  const hostName = (host: unknown): string =>
    typeof host === 'function' && host.name ? host.name : `${spec.name}Module`;

  const deriveKey = (host: unknown, explicit: unknown, structural: object): string => {
    if (explicit === undefined) {
      return spec.key?.(structural as Pick<Opts, S>) ?? stableHash(structural);
    }
    if (typeof explicit !== 'string' || explicit.length === 0 || explicit !== explicit.trim()) {
      throw new TypeError(
        `${hostName(host)}: an explicit module key must be a non-empty string without ` +
          'surrounding whitespace',
      );
    }
    return explicit;
  };

  const applyContributions = (
    definition: DynamicModule,
    structural: object,
    key: string,
  ): DynamicModule => {
    if (!spec.setup) return definition;
    const contributions = spec.setup({
      OPTIONS: optionsToken,
      options: structural as Pick<Opts, S>,
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

  /** Key, contribute, reshape and record one instance from its separated inputs. */
  const buildDefinition = (
    host: unknown,
    registration: Record<PropertyKey, unknown>,
    extras: Record<PropertyKey, unknown>,
    structural: Record<PropertyKey, unknown>,
    base: Pick<DynamicModule, 'imports' | 'providers'>,
    inputs: Record<PropertyKey, unknown>,
  ): DynamicModule => {
    const key = deriveKey(host, registration.key, structural);
    const contributed = applyContributions(
      { module: host as DynamicModule['module'], key, ...base },
      structural,
      key,
    );
    // An extra the call site leaves out, or passes as undefined, takes its
    // default, so `{ isGlobal: false }` and `{}` build the same definition.
    const resolvedExtras = { ...extrasDefaults, ...defined(extras) };
    const shaped = transform(contributed, resolvedExtras);
    // Laziness is OR-composed: the spec defaults it, a call site can add it.
    const lazy = spec.lazy === true || registration.lazy === true;
    return attachModuleIdentity(lazy ? { ...shaped, lazy: true } : shaped, {
      ...inputs,
      extras: identityExtras(resolvedExtras),
      lazy: registration.lazy === true,
    });
  };

  class GeneratedModuleClass {}
  Object.defineProperty(GeneratedModuleClass, 'name', { value: `${spec.name}ModuleHost` });

  Object.defineProperty(GeneratedModuleClass, syncName, {
    configurable: true,
    writable: true,
    enumerable: false,
    value(this: unknown, options: object = {}): DynamicModule {
      const [registration, withExtras] = split(options, REGISTRATION_KEYS);
      const [extras, moduleOptions] = split(withExtras, extrasKeys);
      const [structural] = split(moduleOptions, structuralKeys);
      return buildDefinition(
        this,
        registration,
        extras,
        defined(structural),
        { providers: [defineProvider(optionsToken, { useValue: moduleOptions as Opts })] },
        { options: moduleOptions },
      );
    },
  });

  Object.defineProperty(GeneratedModuleClass, asyncName, {
    configurable: true,
    writable: true,
    enumerable: false,
    value(
      this: unknown,
      options: Pick<
        ConfigurableModuleAsyncFactory<Opts, string>,
        'inject' | 'useFactory' | 'useClass' | 'useExisting'
      > & { imports?: ModuleImport[] },
    ): DynamicModule {
      const [registration, rest] = split(options, REGISTRATION_KEYS);
      const [wiring, callSite] = split(rest, ASYNC_WIRING_KEYS);
      const [extras, others] = split(callSite, extrasKeys);
      // Only declared structural fields belong at the call site; the factory
      // supplies every other option. Anything else would reach neither setup
      // nor the options token, so it fails here instead of vanishing.
      const [structural, unlisted] = split(others, structuralKeys);
      for (const name of Reflect.ownKeys(unlisted)) {
        if (unlisted[name] === undefined) continue;
        throw new TypeError(
          `${hostName(this)}.${asyncName}: '${String(name)}' is neither a structural option ` +
            'nor a registration control; return module options from the factory.',
        );
      }
      const given = defined(structural);
      return buildDefinition(
        this,
        registration,
        extras,
        given,
        {
          imports: options.imports ?? [],
          providers: buildAsyncOptionsProviders<Opts>(
            optionsToken,
            factoryMethodName,
            options,
            given,
            structuralKeys,
            `${hostName(this)}.${asyncName}`,
          ),
        },
        { structural: given, wiring },
      );
    },
  });

  return {
    ConfigurableModuleClass: GeneratedModuleClass as unknown as ConfigurableModuleClassType<
      Opts,
      MethodKey,
      FactoryMethodKey,
      Extras,
      S
    >,
    MODULE_OPTIONS_TOKEN: optionsToken,
    // Type-only sentinels — never read at runtime.
    OPTIONS_TYPE: undefined as never,
    ASYNC_OPTIONS_TYPE: undefined as never,
  };
}

/**
 * Lower `useFactory`/`useClass`/`useExisting` async options into provider
 * registrations. The call-site structural fields complete the resolved
 * options: `setup` built the module from them, so the factory may not return
 * them.
 */
function buildAsyncOptionsProviders<Opts>(
  optionsToken: InjectionToken<Opts>,
  factoryMethodName: string,
  async: Pick<
    ConfigurableModuleAsyncFactory<Opts, string>,
    'inject' | 'useFactory' | 'useClass' | 'useExisting'
  >,
  structural: Record<PropertyKey, unknown>,
  structuralKeys: ReadonlySet<string>,
  caller: string,
): Array<Type | ProviderDefinition> {
  const hasStructural = structuralKeys.size > 0;
  const complete = (resolved: unknown): Opts => {
    if (typeof resolved !== 'object' || resolved === null) {
      throw new TypeError(`${caller}: the factory must return an options object`);
    }
    for (const name of structuralKeys) {
      if (Reflect.get(resolved, name) !== undefined) {
        throw new TypeError(
          `${caller}: the factory returned the structural option '${name}'; ` +
            'pass structural options alongside the factory instead.',
        );
      }
    }
    return { ...resolved, ...structural } as Opts;
  };
  // Without structural fields the resolved options pass through untouched.
  const merge = (resolved: Opts | Promise<Opts>): Opts | Promise<Opts> => {
    if (!hasStructural) return resolved;
    return resolved instanceof Promise ? resolved.then(complete) : complete(resolved);
  };

  if (async.useFactory) {
    const factory = async.useFactory;
    assertFactoryInject(caller, factory, async.inject);
    return [
      defineProvider(optionsToken, {
        useFactory: hasStructural ? (...deps: unknown[]) => merge(factory(...deps)) : factory,
        inject: async.inject ?? [],
      }),
    ];
  }
  const create = (instance: Record<string, () => Opts | Promise<Opts>>): Opts | Promise<Opts> =>
    merge(instance[factoryMethodName]!());
  if (async.useClass) {
    const factoryClass = async.useClass;
    return [
      factoryClass,
      defineProvider(optionsToken, { useFactory: create, inject: [factoryClass] }),
    ];
  }
  if (async.useExisting) {
    return [defineProvider(optionsToken, { useFactory: create, inject: [async.useExisting] })];
  }
  throw new Error(
    'Async module options require one of `useFactory`, `useClass`, or `useExisting`.',
  );
}
