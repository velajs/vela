import {
  InjectionToken,
  defineProvider,
  type InferTokens,
  type ProviderDefinition,
  type Token,
  type Type,
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
import { stableHash } from './stable-hash';

export interface LazyProviderSpec<T, Inject extends readonly Token[]> {
  /** Token under which the memoized thunk `() => T` is provided. */
  provide: InjectionToken<() => T>;
  inject: Inject;
  useFactory: (...deps: InferTokens<Inject>) => NoInfer<T>;
  /** Memoize the first call's result (default true). */
  memoize?: boolean;
}

/**
 * Provide a zero-arg thunk `() => T` whose factory runs on FIRST CALL, not at
 * provider construction — for values that don't exist yet when the module
 * graph is built (Cloudflare bindings are only live at request time).
 *
 * The shared primitive replacing the hand-rolled
 * `useFactory: (...deps) => () => build(...deps)` closure that auth and
 * storage each copy-pasted.
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
  const memoize = spec.memoize ?? true;
  return defineProvider<InjectionToken<() => T>, Inject>(spec.provide, {
    inject: spec.inject,
    useFactory: (...deps) => {
      const build = () => spec.useFactory(...deps);
      if (!memoize) return build;
      let cached: { value: T } | undefined;
      return () => (cached ??= { value: build() }).value;
    },
  });
}

/**
 * The one idiom for registering an app-wide component from a module's
 * providers. Returns registrations to spread:
 *
 * ```ts
 * providers: [MyService, ...provideGlobal('guard', AuthGuard)]
 * ```
 *
 * Class components are registered as providers and wired via `useExisting`
 * (so DI constructs them with their dependencies); instances via `useValue`.
 * Inside `defineModule`, prefer the equivalent `global:` contribution slot.
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
 * A first-class side-effect-only module: contributes providers/exports without
 * being a configurable module — the supported form of the "empty marker
 * module" trick (i18n's `registerMessages`). Content-derived `key` makes
 * identical contributions dedup (HMR-idempotent) while distinct ones coexist.
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
  name: string,
  contributions: Omit<ModuleContributions, 'global'> & { key?: string } = {},
): DynamicModule {
  const { key, ...rest } = contributions;
  // Computed-property-name idiom: mints a class whose .name is `name` without
  // dynamic code evaluation (edge-safe; no `new Function`).
  const moduleClass = { [name]: class {} }[name] as Type;
  Module({})(moduleClass);
  return {
    module: moduleClass,
    key: key ?? stableHash(rest),
    providers: rest.providers ?? [],
    controllers: rest.controllers ?? [],
    imports: rest.imports ?? [],
    exports: rest.exports ?? [],
  };
}

/**
 * Blessed token-minting convention: always an `InjectionToken` (never a raw
 * string), named for diagnostics. Namespace it `'<pkg>:<area>:<thing>'`.
 */
export function moduleToken<T>(name: string): InjectionToken<T> {
  return new InjectionToken<T>(name);
}
