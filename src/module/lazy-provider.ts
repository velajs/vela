import { InjectionToken, type InferTokens, type ProviderOptions, type Token, type Type } from '../container/types';
import { Module } from './decorators';
import type { ComponentType, DynamicModule } from '../registry/types';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from '../pipeline/tokens';
import type { ModuleContributions } from './define-module';
import { stableHash } from './stable-hash';

export interface LazyProviderSpec<T, Inject extends readonly Token<unknown>[]> {
  /** Token under which the memoized thunk `() => T` is provided. */
  provide: Token<() => T>;
  inject?: Inject;
  useFactory: (...deps: InferTokens<Inject>) => T;
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
export function lazyProvider<
  T,
  const Inject extends readonly Token<unknown>[] = readonly Token<unknown>[],
>(spec: LazyProviderSpec<T, Inject>): ProviderOptions {
  const memoize = spec.memoize ?? true;
  return {
    provide: spec.provide as Token,
    inject: [...(spec.inject ?? [])] as Token[],
    useFactory: (...deps: unknown[]) => {
      const build = () => (spec.useFactory as (...a: unknown[]) => T)(...deps);
      if (!memoize) return build;
      let cached: { value: T } | undefined;
      return () => (cached ??= { value: build() }).value;
    },
  };
}

const GLOBAL_COMPONENT_TOKENS: Record<ComponentType, InjectionToken<unknown>> = {
  guard: APP_GUARD,
  pipe: APP_PIPE,
  interceptor: APP_INTERCEPTOR,
  filter: APP_FILTER,
  middleware: APP_MIDDLEWARE,
};

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
export function provideGlobal(
  kind: ComponentType,
  component: Type | object,
): Array<Type | ProviderOptions> {
  const token = GLOBAL_COMPONENT_TOKENS[kind];
  if (typeof component === 'function') {
    return [component as Type, { provide: token, useExisting: component as Token }];
  }
  return [{ provide: token, useValue: component }];
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
