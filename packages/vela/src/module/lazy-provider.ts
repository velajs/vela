import {
  InjectionToken,
  assertFactoryInject,
  defineProvider,
  type InferTokens,
  type ProviderDefinition,
  type Token,
  type Type,
  type ZeroArgumentFactory,
} from '../container/types';
import { Module } from './decorators';
import type { ComponentType, ComponentTypeMap, DynamicModule } from '../registry/types';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from '../pipeline/tokens';
import type { ModuleContributions } from './define-module';
import { attachModuleIdentity } from './module-identity';
import { stableHash } from './stable-hash';

export type LazyProviderSpec<T, Inject extends readonly Token[]> = {
  /** Token under which the memoized thunk `() => T` is provided. */
  provide: InjectionToken<() => T>;
  /** Memoize the first call's result (default true). */
  memoize?: boolean;
} & (
  | { inject: Inject; useFactory: (...deps: InferTokens<Inject>) => NoInfer<T> }
  | ZeroArgumentFactory<Inject, NoInfer<T>>
);

/**
 * Provide a zero-arg thunk `() => T` whose factory runs on FIRST CALL, not at
 * provider construction — for values that don't exist yet when the module
 * graph is built, such as a binding read from `ENV` at request time. A factory
 * without parameters may omit `inject`.
 *
 * ```ts
 * lazyProvider({
 *   provide: STORAGE_DRIVER_BUILDER,
 *   inject: [MODULE_OPTIONS_TOKEN],
 *   useFactory: (options) => options.driver(),
 * })
 * ```
 */
export function lazyProvider<T, const Inject extends readonly Token[] = readonly Token[]>(
  spec: LazyProviderSpec<T, Inject>,
): ProviderDefinition {
  assertFactoryInject(spec.provide, spec.useFactory, spec.inject);
  const memoize = spec.memoize ?? true;
  const thunk = (build: () => T): (() => T) => {
    if (!memoize) return build;
    let cached: { value: T } | undefined;
    return () => (cached ??= { value: build() }).value;
  };
  if (!spec.inject) {
    const factory = spec.useFactory;
    return defineProvider(spec.provide, { useFactory: () => thunk(() => factory()) });
  }
  const factory = spec.useFactory;
  return defineProvider<InjectionToken<() => T>, Inject>(spec.provide, {
    inject: spec.inject,
    useFactory: (...deps: InferTokens<Inject>) => thunk(() => factory(...deps)),
  });
}

/**
 * Register an app-wide component from a module's providers. Returns
 * registrations to spread:
 *
 * ```ts
 * providers: [MyService, ...provideGlobal('guard', AuthGuard)]
 * ```
 *
 * Class components are registered as providers and wired via `useExisting`
 * (so DI constructs them with their dependencies); instances via `useValue`.
 * The literal `{ provide: APP_GUARD, useClass: AuthGuard }` registers the same
 * guard without exposing the class as a provider. Inside `defineModule`, prefer
 * the equivalent `global:` contribution slot.
 */
function componentProviders<T>(
  token: InjectionToken<T>,
  component: Type<T> | T,
): Array<Type | ProviderDefinition> {
  if (typeof component === 'function') {
    const componentClass = component as Type<T>;
    return [componentClass, defineProvider(token, { useExisting: componentClass })];
  }
  return [defineProvider(token, { useValue: component })];
}

export function provideGlobal(
  ...[kind, component]: {
    [K in ComponentType]: [kind: K, component: ComponentTypeMap[K]];
  }[ComponentType]
): Array<Type | ProviderDefinition> {
  switch (kind) {
    case 'guard':
      return componentProviders(APP_GUARD, component);
    case 'pipe':
      return componentProviders(APP_PIPE, component);
    case 'interceptor':
      return componentProviders(APP_INTERCEPTOR, component);
    case 'filter':
      return componentProviders(APP_FILTER, component);
    case 'middleware':
      return componentProviders(APP_MIDDLEWARE, component);
  }
}

/**
 * A side-effect-only module: contributes providers/exports without being a
 * configurable module, such as a message catalog registered next to the module
 * that reads it. Pass a stable module class to deduplicate identical
 * contributions; a string creates a fresh isolated owner. Provider literals are
 * checked when the module loads.
 *
 * ```ts
 * export function registerMessages(messages: Messages): DynamicModule {
 *   return sideEffectModule('I18nMessages', {
 *     providers: [{ provide: I18N_MESSAGES, useValue: messages }],
 *     exports: [I18N_MESSAGES],
 *   });
 * }
 * ```
 */
export function sideEffectModule(
  owner: string | Type,
  contributions: Omit<ModuleContributions, 'global'> & { key?: string } = {},
): DynamicModule {
  const { key, ...rest } = contributions;
  // Computed-property-name idiom: mints a class whose .name is `name` without
  // dynamic code evaluation (edge-safe; no `new Function`).
  const moduleClass = typeof owner === 'string' ? ({ [owner]: class {} }[owner] as Type) : owner;
  if (typeof owner === 'string') Module({})(moduleClass);
  // stableHash cannot see inside provider descriptors or closures, so a stable
  // owner's repeat is compared on these inputs before it is deduplicated.
  return attachModuleIdentity(
    {
      module: moduleClass,
      key: key ?? stableHash(rest),
      providers: rest.providers ?? [],
      controllers: rest.controllers ?? [],
      imports: rest.imports ?? [],
      exports: rest.exports ?? [],
    },
    rest,
  );
}

/**
 * Blessed token-minting convention: always an `InjectionToken` (never a raw
 * string), named for diagnostics. Namespace it `'<pkg>:<area>:<thing>'`.
 */
export function moduleToken<T>(name: string): InjectionToken<T> {
  return new InjectionToken<T>(name);
}
