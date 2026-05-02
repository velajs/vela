import { Scope } from '../constants';
import {
  getConstructorDependencies,
  getInjectMetadata,
  getScope,
  isInjectable,
} from './decorators';
import type {
  ContainerOptions,
  Diagnostics,
  ModuleScope,
  ProviderOptions,
  ProviderRegistration,
  Token,
  Type,
} from './types';
import {
  ForwardRef,
  InjectionToken,
  ModuleVisibilityError,
  MultipleProvidersFoundError,
  ROOT_MODULE_ID,
} from './types';

const IMPORT_TYPE_HINT =
  'Did you use `import type { X }`? TypeScript strips type-only imports at ' +
  'runtime and `design:paramtypes` emits `Object`/`undefined` for their ' +
  'positions. Use a runtime `import { X }` for DI tokens.';

/**
 * Sentinel comparing a token to the bare `Object` class — `design:paramtypes`
 * emits `Object` when TypeScript erases a type-only import, so any token that
 * is `Object` (or nullish) is the fingerprint of a stripped type.
 */
function isErasedTypeToken(token: unknown): boolean {
  return token === Object || token == null;
}

/**
 * Per-module provider buckets. Each module instance owns its providers under
 * its `moduleId`; the same logical token can have distinct registrations in
 * different buckets, supporting multi-instance dynamic modules.
 *
 * The `__root__` bucket holds bootstrap-time framework primitives (Container,
 * ModuleRef, REQUEST_CONTEXT, etc.) and any `register()` call that doesn't
 * supply a `declaringModuleId`.
 */
export class Container {
  private providers = new Map<string, Map<Token, ProviderRegistration>>();
  private exporterIndex = new Map<Token, Set<string>>();
  private resolutionStack = new Set<Token>();
  private requestInstances = new Map<Token, unknown>();
  private scopes = new Map<string, ModuleScope>();
  private globals = new Set<Token>();
  private diagnostics: Diagnostics;

  constructor(options: ContainerOptions = {}) {
    this.diagnostics = options.diagnostics ?? 'log';
  }

  register<T>(
    provider: Type<T> | ProviderOptions<T>,
    declaringModuleId?: string,
  ): this {
    const moduleId = declaringModuleId ?? ROOT_MODULE_ID;
    if (typeof provider === 'function') {
      this.registerClass(provider, moduleId);
    } else {
      this.registerOptions(provider, moduleId);
    }
    return this;
  }

  private registerClass<T>(target: Type<T>, moduleId: string): void {
    if (!isInjectable(target)) {
      console.warn(
        `Warning: ${target.name} is not decorated with @Injectable(). ` +
          `It will be registered but dependency resolution may not work correctly.`,
      );
    }

    const scope = getScope(target);
    this.writeRegistration(moduleId, target, {
      provide: target,
      scope,
      declaringModuleId: moduleId,
      useClass: target,
    });
  }

  private registerOptions<T>(options: ProviderOptions<T>, moduleId: string): void {
    const token = options.provide;
    if (!token) {
      throw new Error('Provider registration requires a token');
    }

    const registration: ProviderRegistration<T> = {
      provide: token,
      scope: options.scope ?? Scope.SINGLETON,
      declaringModuleId: moduleId,
    };

    if (options.useValue !== undefined) {
      registration.useValue = options.useValue;
      registration.instance = options.useValue;
    } else if (options.useFactory) {
      registration.useFactory = options.useFactory;
      registration.inject = options.inject;
    } else if (options.useClass) {
      registration.useClass = options.useClass;
    } else if (options.useExisting) {
      registration.useExisting = options.useExisting;
    } else if (typeof token === 'function') {
      registration.useClass = token;
    }

    this.writeRegistration(moduleId, token, registration);
  }

  private writeRegistration(
    moduleId: string,
    token: Token,
    registration: ProviderRegistration,
  ): void {
    let bucket = this.providers.get(moduleId);
    if (!bucket) {
      bucket = new Map();
      this.providers.set(moduleId, bucket);
    }
    bucket.set(token, registration);

    let exporters = this.exporterIndex.get(token);
    if (!exporters) {
      exporters = new Set();
      this.exporterIndex.set(token, exporters);
    }
    exporters.add(moduleId);
  }

  registerScope(scope: ModuleScope): void {
    this.scopes.set(scope.moduleId, scope);
    if (!this.providers.has(scope.moduleId)) {
      this.providers.set(scope.moduleId, new Map());
    }
    if (scope.isGlobal) {
      // Match NestJS / the loader's existing globalExports semantic: only
      // exported tokens become globally visible. Non-exported providers of
      // a @Global module still need explicit imports.
      for (const token of scope.exportedTokens) this.globals.add(token);
    }
  }

  markGlobalToken(token: Token): void {
    this.globals.add(token);
  }

  // Pre-seed the per-request cache. Only meaningful on a child container
  // produced by createChild() — the root's requestInstances map is unused.
  // Used by RouteManager to populate framework-provided request-scope
  // values (REQUEST_CONTEXT) before any handler resolution runs, so the
  // provider's factory never fires on the request path.
  setRequestInstance(token: Token, value: unknown): void {
    this.requestInstances.set(token, value);
  }

  getDiagnostics(): Diagnostics {
    return this.diagnostics;
  }

  resolve<T>(token: Token<T>, requestingModuleId?: string): T {
    const registration = this.findRegistration<T>(token, requestingModuleId);
    if (registration) {
      return this.resolveRegistration(registration, requestingModuleId);
    }

    // Visibility error fires first when the token exists in some bucket but
    // isn't reachable from the requester's scope — the user wants to know
    // their wiring is wrong, not that the token doesn't exist.
    if (
      requestingModuleId !== undefined &&
      this.scopes.has(requestingModuleId) &&
      this.exporterIndex.has(token)
    ) {
      throw new ModuleVisibilityError(requestingModuleId, token);
    }

    // `Object`/undefined at a token position is the fingerprint of a
    // type-only import that TypeScript stripped — emit the hint before
    // attempting any other recovery.
    if (isErasedTypeToken(token)) {
      throw new Error(
        `No provider found for token: ${this.tokenToString(token)}. ` +
          IMPORT_TYPE_HINT,
      );
    }

    if (typeof token === 'function') {
      throw new Error(
        `No provider found for token: ${this.tokenToString(token)}. ` +
          `Declare it in a module's providers.`,
      );
    }

    // InjectionToken default factories are explicit user declarations
    // attached to the token at construction — self-providing singletons.
    if (token instanceof InjectionToken && token.options?.factory) {
      this.register({ provide: token, useFactory: token.options.factory });
      return this.resolve(token, requestingModuleId);
    }

    throw new Error(`No provider found for token: ${this.tokenToString(token)}`);
  }

  resolveAll<T>(token: Token<T>, requestingModuleId?: string): T[] {
    const registrations = this.findAllRegistrations<T>(token, requestingModuleId);
    return registrations.map((r) => this.resolveRegistration(r, requestingModuleId));
  }

  /**
   * Find a single reachable registration for a token, applying the visibility
   * walk: requester's bucket → globals → requester's importedModules
   * (transitively, following re-exports).
   *
   * Returns `undefined` if no candidate exists. Throws
   * `MultipleProvidersFoundError` if the imports walk yields more than one.
   */
  private findRegistration<T>(
    token: Token<T>,
    requestingModuleId?: string,
  ): ProviderRegistration<T> | undefined {
    // No requester OR no scope for this requester: framework-internal /
    // sandbox lookup. Prefer the `__root__` bucket so sandbox-registered
    // transients (ModuleRef.create) and bootstrap primitives win over module
    // buckets that may hold the same token under SINGLETON scope.
    if (requestingModuleId === undefined || !this.scopes.has(requestingModuleId)) {
      const rootHit = this.lookupInBucket<T>(ROOT_MODULE_ID, token);
      if (rootHit) return rootHit;
      const exporters = this.exporterIndex.get(token);
      if (!exporters) return undefined;
      for (const owner of exporters) {
        const hit = this.lookupInBucket<T>(owner, token);
        if (hit) return hit;
      }
      return undefined;
    }

    // 1. Local bucket.
    const local = this.lookupInBucket<T>(requestingModuleId, token);
    if (local) return local;

    // 2. Global tokens — registration still lives in some module's bucket.
    if (this.globals.has(token)) {
      const exporters = this.exporterIndex.get(token);
      if (exporters && exporters.size > 0) {
        if (exporters.size > 1) {
          throw new MultipleProvidersFoundError(requestingModuleId, token, [
            ...exporters,
          ]);
        }
        const [owner] = [...exporters];
        return this.lookupInBucket<T>(owner, token);
      }
      return undefined;
    }

    // 3. InjectionToken with default factory — self-providing from any
    // scope. If already auto-registered (in `__root__`), return that;
    // otherwise let the caller materialize it.
    if (token instanceof InjectionToken && token.options?.factory) {
      return this.lookupInBucket<T>(ROOT_MODULE_ID, token);
    }

    // 4. Imported modules' exports — walk transitively so re-exports work.
    const scope = this.scopes.get(requestingModuleId);
    if (!scope) return undefined;

    const candidates: ProviderRegistration<T>[] = [];
    const candidateModuleIds: string[] = [];
    const visited = new Set<string>([requestingModuleId]);
    this.collectFromImports<T>(scope, token, visited, candidates, candidateModuleIds);

    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) {
      throw new MultipleProvidersFoundError(
        requestingModuleId,
        token,
        candidateModuleIds,
      );
    }
    return candidates[0];
  }

  /** Typed bucket lookup — single seam where the Map<Token, Registration> erases T. */
  private lookupInBucket<T>(
    moduleId: string,
    token: Token<T>,
  ): ProviderRegistration<T> | undefined {
    return this.providers.get(moduleId)?.get(token) as ProviderRegistration<T> | undefined;
  }

  /**
   * Walk a scope's imports (and their imports' imports, …) collecting every
   * registration reachable through re-export chains. A child only contributes
   * if it explicitly exports the token — non-exported providers stay private.
   */
  private collectFromImports<T>(
    scope: ModuleScope,
    token: Token<T>,
    visited: Set<string>,
    candidates: ProviderRegistration<T>[],
    candidateModuleIds: string[],
  ): void {
    for (const importedId of scope.importedModules) {
      if (visited.has(importedId)) continue;
      visited.add(importedId);
      const imported = this.scopes.get(importedId);
      if (!imported?.exportedTokens.has(token)) continue;

      const direct = this.lookupInBucket<T>(importedId, token);
      if (direct) {
        candidates.push(direct);
        candidateModuleIds.push(importedId);
        continue;
      }

      // Imported module re-exports the token without owning it — recurse
      // into ITS imports.
      this.collectFromImports<T>(
        imported,
        token,
        visited,
        candidates,
        candidateModuleIds,
      );
    }
  }

  private findAllRegistrations<T>(
    token: Token<T>,
    requestingModuleId?: string,
  ): ProviderRegistration<T>[] {
    if (requestingModuleId === undefined) {
      const exporters = this.exporterIndex.get(token);
      if (!exporters) return [];
      return [...exporters]
        .map((id) => this.lookupInBucket<T>(id, token))
        .filter((r): r is ProviderRegistration<T> => r !== undefined);
    }

    const out: ProviderRegistration<T>[] = [];
    const seen = new Set<ProviderRegistration<T>>();

    const local = this.lookupInBucket<T>(requestingModuleId, token);
    if (local && !seen.has(local)) {
      out.push(local);
      seen.add(local);
    }

    if (this.globals.has(token)) {
      for (const owner of this.exporterIndex.get(token) ?? []) {
        const reg = this.lookupInBucket<T>(owner, token);
        if (reg && !seen.has(reg)) {
          out.push(reg);
          seen.add(reg);
        }
      }
    }

    const scope = this.scopes.get(requestingModuleId);
    if (scope) {
      for (const importedId of scope.importedModules) {
        const imported = this.scopes.get(importedId);
        if (!imported?.exportedTokens.has(token)) continue;
        const reg = this.lookupInBucket<T>(importedId, token);
        if (reg && !seen.has(reg)) {
          out.push(reg);
          seen.add(reg);
        }
      }
    }

    return out;
  }

  /** True if any bucket has a registration for `token`. Sandbox-friendly. */
  has(token: Token): boolean {
    return this.exporterIndex.has(token);
  }

  /** True if the specified module's bucket has a registration for `token`. */
  hasInScope(token: Token, moduleId: string): boolean {
    return this.providers.get(moduleId)?.has(token) ?? false;
  }

  getProviderScope(token: Token): Scope | undefined {
    const exporters = this.exporterIndex.get(token);
    if (!exporters) return undefined;
    for (const owner of exporters) {
      const reg = this.providers.get(owner)?.get(token);
      if (reg) return reg.scope;
    }
    return undefined;
  }

  getTokens(): Token[] {
    const out = new Set<Token>();
    for (const bucket of this.providers.values()) {
      for (const token of bucket.keys()) out.add(token);
    }
    return [...out];
  }

  /**
   * Create a child container for request-scoped resolution.
   * The child shares the parent's providers but caches REQUEST-scoped
   * instances separately per child (per request).
   */
  createChild(): Container {
    const child = new Container({ diagnostics: this.diagnostics });
    // Share state by reference — request-scope children must see the same
    // module graph as the root.
    child.providers = this.providers;
    child.exporterIndex = this.exporterIndex;
    child.scopes = this.scopes;
    child.globals = this.globals;
    return child;
  }

  createDetached(): Container {
    const child = new Container({ diagnostics: this.diagnostics });
    // Deep-clone provider buckets so sandbox writes don't leak back to the
    // parent. Inner ProviderRegistration objects are shallow-shared (we only
    // mutate `instance` cache, and per-bucket clones already give per-sandbox
    // singleton isolation when needed).
    const clonedProviders = new Map<string, Map<Token, ProviderRegistration>>();
    for (const [moduleId, bucket] of this.providers) {
      clonedProviders.set(moduleId, new Map(bucket));
    }
    child.providers = clonedProviders;

    const clonedIndex = new Map<Token, Set<string>>();
    for (const [token, owners] of this.exporterIndex) {
      clonedIndex.set(token, new Set(owners));
    }
    child.exporterIndex = clonedIndex;

    child.scopes = this.scopes;
    child.globals = this.globals;
    return child;
  }

  clear(): void {
    this.providers.clear();
    this.exporterIndex.clear();
    this.resolutionStack.clear();
    this.requestInstances.clear();
    this.scopes.clear();
    this.globals.clear();
  }

  private resolveRegistration<T>(
    registration: ProviderRegistration<T>,
    requestingModuleId?: string,
  ): T {
    if (registration.useValue !== undefined) {
      return registration.useValue;
    }

    if (registration.useExisting) {
      // Pass through the original requester to catch alias leaks
      return this.resolve(registration.useExisting, requestingModuleId);
    }

    // Singleton: return cached from registration (shared across all containers)
    if (registration.scope === Scope.SINGLETON && registration.instance !== undefined) {
      return registration.instance;
    }

    // Request: return cached from this child's requestInstances
    if (registration.scope === Scope.REQUEST) {
      const cached = this.requestInstances.get(registration.provide) as T | undefined;
      if (cached !== undefined) {
        return cached;
      }
    }

    if (this.resolutionStack.has(registration.provide)) {
      const chain = [...this.resolutionStack, registration.provide]
        .map((t) => this.tokenToString(t))
        .join(' -> ');
      throw new Error(`Circular dependency detected: ${chain}`);
    }

    this.resolutionStack.add(registration.provide);

    try {
      let instance: T;

      if (registration.useFactory) {
        // Factories (forRootAsync, useFactory) commonly inject deps from the
        // importing module's scope. Vela has no `forRootAsync({ imports })`
        // surface to track that, so factory inject deps resolve from the
        // declaring module's POV — same escape-hatch shape as ModuleRef.
        instance = this.resolveFactory(registration);
      } else if (registration.useClass) {
        instance = this.resolveClass(registration.useClass, registration.declaringModuleId);
      } else {
        throw new Error(
          `Invalid provider registration for: ${this.tokenToString(registration.provide)}`,
        );
      }

      if (registration.scope === Scope.SINGLETON) {
        registration.instance = instance;
      } else if (registration.scope === Scope.REQUEST) {
        this.requestInstances.set(registration.provide, instance);
      }

      return instance;
    } finally {
      this.resolutionStack.delete(registration.provide);
    }
  }

  private resolveClass<T>(target: Type<T>, ownerModuleId: string): T {
    const paramTypes = getConstructorDependencies(target);
    const injectMetadata = getInjectMetadata(target);
    const injectMap = new Map(injectMetadata.map((m) => [m.index, m]));

    const dependencies = paramTypes.map((paramType, index) => {
      const meta = injectMap.get(index);
      const rawToken = meta?.token;
      const isForwardRef = rawToken instanceof ForwardRef;
      const token: Token | undefined = isForwardRef
        ? rawToken.factory()
        : rawToken ?? paramType;

      if (!token || isErasedTypeToken(token)) {
        if (meta?.optional) return undefined;
        throw new Error(
          `Cannot resolve dependency at index ${index} for ${target.name}. ` +
            `Parameter type is undefined or Object. ` +
            IMPORT_TYPE_HINT +
            ` Alternatively, use \`@Inject()\` to specify the token explicitly.`,
        );
      }

      if (meta?.optional && !this.has(token)) {
        return undefined;
      }

      // forwardRef with circular dep — break the cycle with a lazy Proxy
      if (isForwardRef && this.resolutionStack.has(token)) {
        return this.createLazyProxy(token, ownerModuleId);
      }

      return this.resolve(token, ownerModuleId);
    });

    return new target(...dependencies);
  }

  private resolveFactory<T>(registration: ProviderRegistration<T>): T {
    if (!registration.useFactory) {
      throw new Error('Factory function is missing');
    }

    // Factory inject deps resolve without a requester — Vela has no
    // `forRootAsync({ imports })` surface to track which module the factory
    // resolves from, so it uses the same escape-hatch shape as ModuleRef.
    const dependencies = (registration.inject || []).map((token) => {
      const resolved = token instanceof ForwardRef ? token.factory() : token;
      return this.resolve(resolved);
    });
    const result = registration.useFactory(...dependencies);

    if (result instanceof Promise) {
      throw new Error(
        `Async factory for ${this.tokenToString(registration.provide)} returned a Promise. ` +
          `Use resolveAsync() for async providers.`,
      );
    }

    return result;
  }

  async resolveAsync<T>(token: Token<T>, requestingModuleId?: string): Promise<T> {
    const registration = this.findRegistration<T>(token, requestingModuleId);

    if (!registration) {
      if (
        requestingModuleId !== undefined &&
        this.scopes.has(requestingModuleId) &&
        this.exporterIndex.has(token)
      ) {
        throw new ModuleVisibilityError(requestingModuleId, token);
      }
      if (typeof token === 'function') {
        throw new Error(
          `No provider found for token: ${this.tokenToString(token)}. ` +
            `Declare it in a module's providers.`,
        );
      }
      if (token instanceof InjectionToken && token.options?.factory) {
        this.register({ provide: token, useFactory: token.options.factory });
        return this.resolveAsync(token, requestingModuleId);
      }
      throw new Error(`No provider found for token: ${this.tokenToString(token)}`);
    }

    if (registration.useFactory) {
      if (registration.scope === Scope.SINGLETON && registration.instance !== undefined) {
        return registration.instance;
      }

      // Factory inject deps resolve without a requester (same escape hatch as
      // sync resolveFactory).
      const dependencies = await Promise.all(
        (registration.inject || []).map((t) => {
          const resolved = t instanceof ForwardRef ? t.factory() : t;
          return this.resolveAsync(resolved);
        }),
      );

      const instance = await registration.useFactory(...dependencies);

      if (registration.scope === Scope.SINGLETON) {
        registration.instance = instance;
      }

      return instance;
    }

    return this.resolve(token, requestingModuleId);
  }

  private createLazyProxy(token: Token, requestingModuleId?: string): object {
    const container = this;
    const target: Record<PropertyKey, unknown> = Object.create(null);
    return new Proxy(target, {
      get(_target, prop) {
        const instance = container.resolve(token, requestingModuleId);
        // The cast yields `unknown` (vs `Reflect.get`'s `any`), keeping the
        // typeof-narrows-to-Function guard below honest.
        const value = (instance as Record<PropertyKey, unknown>)[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
      },
      set(_target, prop, value) {
        const instance = container.resolve(token, requestingModuleId);
        (instance as Record<PropertyKey, unknown>)[prop] = value;
        return true;
      },
    });
  }

  private tokenToString(token: Token): string {
    if (token instanceof InjectionToken) {
      return token.toString();
    }
    if (typeof token === 'function') {
      return token.name;
    }
    if (typeof token === 'symbol') {
      return token.toString();
    }
    return String(token);
  }
}
