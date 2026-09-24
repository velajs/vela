import type { ProviderDefinition, Token, Type } from './types';

// Deliberately module-local, not anchored on `globalThis` like decoration
// metadata: entries are provider classes, and a second copy of the package
// must register its own classes, never another copy's.
const declared = new Map<Token, Type | ProviderDefinition>();

/**
 * @internal Declare a framework provider every application registers in its
 * root container as a global default (see `bootstrap`). One `@Global()`
 * module exporting the token overrides it application-wide, and what the
 * application configures itself (the `env` option, a runtime adapter,
 * testing overrides) wins over both.
 *
 * Call it at module scope, next to the class or token it provides. A bundle
 * that never references that module then never ships it, while an application
 * that does gets it registered exactly as if bootstrap named it. The latest
 * declaration for a token wins.
 */
export function declareRootDefault(provider: Type | ProviderDefinition): void {
  declared.set(typeof provider === 'function' ? provider : provider.provide, provider);
}

/** @internal The declared root defaults, keyed by token, in declaration order. */
export function getRootDefaults(): ReadonlyMap<Token, Type | ProviderDefinition> {
  return declared;
}
