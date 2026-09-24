import {
  type InjectionToken,
  assertFactoryInject,
  toProviderDefinition,
  type InferTokens,
  type ProviderDefinition,
  type Token,
  type Type,
  type FactoryInject,
} from '../container/types';
import { Module } from './decorators';
import type { DynamicModule } from '../registry/types';
import type { ModuleContributions } from './define-module';
import { attachModuleIdentity } from './module-fingerprints';
import { stableHash } from './stable-hash';

export type LazyProviderSpec<T, Inject extends readonly Token[]> = {
  /** Token under which the memoized thunk `() => T` is provided. */
  provide: InjectionToken<() => T>;
  useFactory: (...deps: InferTokens<Inject>) => NoInfer<T>;
  /** Memoize the first call's result (default true). */
  memoize?: boolean;
} & FactoryInject<Inject>;

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
  const { provide, inject, useFactory, memoize = true } = spec;
  assertFactoryInject(provide, useFactory, inject);
  return toProviderDefinition(
    {
      provide,
      inject,
      useFactory: (...deps: InferTokens<Inject>) => {
        const build = () => useFactory(...deps);
        if (!memoize) return build;
        let cached: { value: T } | undefined;
        return () => (cached ??= { value: build() }).value;
      },
    },
    'lazyProvider',
  );
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
