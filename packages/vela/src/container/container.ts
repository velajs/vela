import { Scope } from '../constants';
import { reportDiagnostic } from './diagnostics';
import { disposeInstance, isDisposable } from './disposable';
import {
  describeUndecoratedParameters,
  getScope,
  isDecoratedClass,
  isErasedTypeToken,
  planConstructor,
} from './decorators';
import { ModuleRef } from './module-ref';
import type {
  ConstructorDependency,
  ContainerOptions,
  AuthoringToken,
  Diagnostics,
  InferToken,
  LazyResolutionHook,
  ModuleDescription,
  ModuleScope,
  ProviderOptions,
  ProviderDefinition,
  ProviderRegistration,
  ProviderSnapshot,
  Token,
  Type,
  UnresolvedDependencyReason,
} from './types';
import {
  describeToken,
  getProviderOptions,
  ForwardRef,
  InjectionToken,
  ModuleVisibilityError,
  MultipleProvidersFoundError,
  ROOT_MODULE_ID,
  UnresolvedDependencyError,
} from './types';

const IMPORT_TYPE_HINT =
  'Did you use `import type { X }`? TypeScript strips type-only imports at ' +
  'runtime and `design:paramtypes` emits `Object`/`undefined` for their ' +
  'positions. Use a runtime `import { X }` for DI tokens.';

function isReference(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function requestScopeOnRoot(registration: ProviderRegistration): Error {
  const name = describeToken(registration.provide);
  const bubbled =
    registration.scope === Scope.REQUEST ? '' : ' (it depends on a request-scoped provider)';
  return new Error(
    `Cannot resolve request-scoped provider ${name}${bubbled} on the root container: its ` +
      `instances belong to one request or invocation. Resolve it from that execution scope's ` +
      `container (getRequestContainer(c), context.getContainer(), runInEntrypointScope()) or ` +
      `pass the context to ModuleRef.resolve(token, context).`,
  );
}

/**
 * Per-module provider buckets. Each module instance owns its providers under
 * its `moduleId`; the same logical token can have distinct registrations in
 * different buckets, supporting multi-instance dynamic modules.
 *
 * The `__root__` bucket holds bootstrap-time framework primitives (Container,
 * REQUEST_CONTEXT, etc.) and any `register()` call that doesn't supply a
 * `declaringModuleId`. `ModuleRef` is never registered: the container builds
 * one per requesting module and owner container on demand.
 */
export class Container {
  #providers = new Map<string, Map<Token, ProviderRegistration>>();
  #exporterIndex = new Map<Token, Set<string>>();
  #resolutionStack = new Set<ProviderRegistration>();
  #requestInstances = new Map<ProviderRegistration, { readonly value: unknown }>();
  #requestSeeds = new Map<Token, { readonly value: unknown }>();
  #pendingInstances = new Map<ProviderRegistration, Promise<unknown>>();
  #scopes = new Map<string, ModuleScope>();
  // Global token → the @Global modules exporting it (none for a framework
  // token, which only the `__root__` bucket provides).
  #globals = new Map<Token, Set<string>>();
  #diagnostics: Diagnostics;
  // The root container that owns shared state; a request child points back here
  // so container-constructed singletons are tracked (and disposed) at the root,
  // never by the ephemeral child that happened to first resolve them.
  #root: Container = this;
  // Container-constructed instances in creation order, for LIFO disposal.
  // useValue providers are never tracked (they return before construction).
  #disposables = new Set<unknown>();
  // Root-owned identity ledger: null denotes a caller-owned value/seed. A
  // factory returning an existing dependency cannot transfer its ownership.
  #disposalOwners = new WeakMap<object, Container | null>();
  #pendingConstructions = new Set<Promise<unknown>>();
  #disposing?: Promise<void>;
  #constructionOwner: Container = this;
  // Lazy-module seam (root-owned; children reach it via this.#root). A
  // resolution of a deferred registration CLAIMS its module; claimed groups
  // are completed (constructed + hooks replayed) only when the resolution
  // stack has unwound and no resolveAsync cascade is in flight — running the
  // replay mid-construction could force-resolve a class currently on the
  // resolution stack (discovery cascades) and mint a spurious
  // circular-dependency error.
  #lazyHook?: LazyResolutionHook;
  #asyncDepth = 0;
  // ModuleRefs this container owns, per requesting module. The root owns
  // those of singletons; a request child those of its request consumers.
  #moduleRefs = new Map<string, ModuleRef>();
  // Root-owned: hidden @Optional() dependencies already warned about.
  #reportedHiddenOptionals = new Map<Token, Set<string>>();

  constructor(options: ContainerOptions = {}) {
    this.#diagnostics = options.diagnostics ?? 'log';
  }

  /** Install the lazy-module seam (bootstrap-time; root container only). */
  setLazyHook(hook: LazyResolutionHook): void {
    this.#root.#lazyHook = hook;
  }

  private claimLazyModule(declaringModuleId: string): void {
    const hook = this.#root.#lazyHook;
    if (hook?.isPending(declaringModuleId)) {
      hook.claim(declaringModuleId);
    }
  }

  private maybeDrainSync(): void {
    const root = this.#root;
    const hook = root.#lazyHook;
    if (!hook?.hasClaimed()) return;
    // Never replay hooks while construction is in flight; an async cascade
    // drains (with await) at its own end instead. A running drain picks
    // pending claims up itself — re-entering it is at best a no-op and on
    // the async path a self-deadlock.
    if (this.#resolutionStack.size > 0) return;
    if (root.#asyncDepth > 0) return;
    if (hook.isDraining()) return;
    hook.drainSync();
  }

  register<T>(provider: Type<T> | ProviderDefinition<T>, declaringModuleId?: string): this {
    const moduleId = declaringModuleId ?? ROOT_MODULE_ID;
    if (typeof provider === 'function') {
      this.registerClass(provider, moduleId);
    } else {
      this.registerOptions(getProviderOptions(provider), moduleId);
    }
    return this;
  }

  private registerClass<T>(target: Type<T>, moduleId: string): void {
    const dependencies = this.#planClass(target);
    if (dependencies.length >= target.length && !isDecoratedClass(target)) {
      reportDiagnostic(
        this.#diagnostics,
        `[vela] ${target.name} is not decorated with @Injectable(). Decorate provider ` +
          'classes so the build emits the constructor metadata dependency injection reads.',
      );
    }

    const scope = getScope(target);
    this.writeRegistration(moduleId, target, {
      provide: target,
      scope,
      declaringModuleId: moduleId,
      useClass: target,
      dependencies,
    });
  }

  private registerOptions(options: ProviderOptions, moduleId: string): void {
    const token = options.provide;
    if (!token) {
      throw new Error('Provider registration requires a token');
    }

    const registration: ProviderRegistration = {
      provide: token,
      scope: options.scope ?? Scope.DEFAULT,
      declaringModuleId: moduleId,
    };

    if ('useValue' in options) {
      this.rememberCallerOwned(options.useValue);
      registration.value = { value: options.useValue };
      registration.instance = { value: options.useValue };
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

    if (registration.useClass) {
      registration.dependencies = this.#planClass(registration.useClass);
      // A constructed class keeps its declared @Injectable scope unless the
      // provider overrides it; otherwise a REQUEST-scoped implementation would
      // silently become a singleton shared across requests.
      if (options.scope === undefined) registration.scope = getScope(registration.useClass);
    }

    this.writeRegistration(moduleId, token, registration);
  }

  // An undecorated class constructed without the parameters it declares is a
  // wiring problem the application may survive (a third-party class taking
  // optional arguments), so it goes through the diagnostics policy.
  #planClass(target: Type): ConstructorDependency[] {
    const dependencies = planConstructor(target);
    const undecorated = describeUndecoratedParameters(target, dependencies);
    if (undecorated !== undefined) reportDiagnostic(this.#diagnostics, undecorated);
    return dependencies;
  }

  private writeRegistration(
    moduleId: string,
    token: Token,
    registration: ProviderRegistration,
  ): void {
    let bucket = this.#providers.get(moduleId);
    if (!bucket) {
      bucket = new Map();
      this.#providers.set(moduleId, bucket);
    }
    bucket.set(token, registration);

    let exporters = this.#exporterIndex.get(token);
    if (!exporters) {
      exporters = new Set();
      this.#exporterIndex.set(token, exporters);
    }
    exporters.add(moduleId);
  }

  registerScope(scope: ModuleScope): void {
    this.#scopes.set(scope.moduleId, scope);
    if (!this.#providers.has(scope.moduleId)) {
      this.#providers.set(scope.moduleId, new Map());
    }
    if (scope.isGlobal) {
      // Match NestJS / the loader's existing globalExports semantic: only
      // exported tokens become globally visible. Non-exported providers of
      // a @Global module still need explicit imports.
      for (const token of scope.exportedTokens) {
        this.markGlobalToken(token);
        this.#globals.get(token)!.add(scope.moduleId);
      }
    }
  }

  /** The registered scope of one module instance (shared by request children). */
  getModuleScope(moduleId: string): Readonly<ModuleScope> | undefined {
    return this.#scopes.get(moduleId);
  }

  markGlobalToken(token: Token): void {
    if (!this.#globals.has(token)) this.#globals.set(token, new Set());
  }

  // Explicit seeds override constructed REQUEST values for this token, but
  // never create registrations or bypass the requester's module visibility.
  // Keep them separate from the registration-keyed constructed-instance cache.
  // Used by RouteManager to populate framework-provided request-scope
  // values (REQUEST_CONTEXT) before any handler resolution runs, so the
  // provider's factory never fires on the request path.
  setRequestInstance<K extends Token>(
    token: K & AuthoringToken<K>,
    value: NoInfer<InferToken<K>>,
  ): void {
    this.rememberCallerOwned(value);
    this.#requestSeeds.set(token, { value });
  }

  getDiagnostics(): Diagnostics {
    return this.#diagnostics;
  }

  resolve<K extends Token>(token: K, requestingModuleId?: string): InferToken<K>;
  resolve(token: Token, requestingModuleId?: string): unknown {
    this.#assertNotDisposing();
    return this.#resolveToken(token, requestingModuleId);
  }

  // Heterogeneous provider storage erases its token/value correlation. Keep
  // this generic resolution boundary private; callers infer from the token.
  #resolveToken<T>(token: Token, requestingModuleId?: string): T {
    if (token === ModuleRef) {
      // The ModuleRef token carries its own value type; the generic boundary erases it.
      return this.#constructionOwner.moduleRefFor(requestingModuleId) as T;
    }
    const registration = this.#findRegistration<T>(token, requestingModuleId);
    if (registration) {
      const instance = this.resolveRegistration(registration);
      this.maybeDrainSync();
      return instance;
    }

    // Visibility error fires first when the token exists in some bucket but
    // isn't reachable from the requester's scope — the user wants to know
    // their wiring is wrong, not that the token doesn't exist.
    if (
      requestingModuleId !== undefined &&
      this.#scopes.has(requestingModuleId) &&
      this.#exporterIndex.has(token)
    ) {
      throw new ModuleVisibilityError(requestingModuleId, token);
    }

    // `Object`/undefined at a token position is the fingerprint of a
    // type-only import that TypeScript stripped — emit the hint before
    // attempting any other recovery.
    if (isErasedTypeToken(token)) {
      throw new Error(
        `No provider found for token: ${this.#tokenToString(token)}. ` + IMPORT_TYPE_HINT,
      );
    }

    if (typeof token === 'function') {
      throw new Error(
        `No provider found for token: ${this.#tokenToString(token)}. ` +
          `Declare it in a module's providers.`,
      );
    }

    // InjectionToken default factories are explicit user declarations
    // attached to the token at construction: self-providing, in the scope the
    // token declares (a singleton unless it says otherwise).
    if (token instanceof InjectionToken && token.options?.factory) {
      this.registerTokenDefault(token, token.options.factory);
      return this.#resolveToken<T>(token, requestingModuleId);
    }

    throw new Error(`No provider found for token: ${this.#tokenToString(token)}`);
  }

  resolveAll<K extends Token>(token: K, requestingModuleId?: string): InferToken<K>[];
  resolveAll<T>(token: Token, requestingModuleId?: string): T[] {
    this.#assertNotDisposing();
    const registrations = this.findAllRegistrations<T>(token, requestingModuleId);
    const instances = registrations.map((r) => this.resolveRegistration(r));
    this.maybeDrainSync();
    return instances;
  }

  /**
   * The same visible candidates as resolveAll(), without constructing anything
   * or claiming lazy modules. Snapshots/cells are frozen; application instances
   * stay referenced and are deliberately not frozen or coerced to domain types.
   */
  getVisibleProviderSnapshots(
    token: Token,
    requestingModuleId?: string,
  ): readonly ProviderSnapshot[] {
    return Object.freeze(
      this.findAllRegistrations(token, requestingModuleId).map((registration): ProviderSnapshot => {
        const scope = registration.effectiveScope ?? registration.scope;
        const instance =
          registration.value ??
          (scope === Scope.REQUEST
            ? (this.#requestSeeds.get(registration.provide) ??
              this.#requestInstances.get(registration))
            : registration.instance);
        return Object.freeze({
          token: registration.provide,
          moduleId: registration.declaringModuleId,
          scope,
          kind: registration.value
            ? 'value'
            : registration.useExisting
              ? 'existing'
              : registration.useFactory
                ? 'factory'
                : 'class',
          useClass: registration.useClass,
          useExisting: registration.useExisting,
          instance: instance && Object.freeze({ value: instance.value }),
        });
      }),
    );
  }

  /**
   * Find a single reachable registration for a token, applying the visibility
   * walk: requester's bucket → globals → requester's importedModules
   * (transitively, following re-exports).
   *
   * Returns `undefined` if no candidate exists. Throws
   * `MultipleProvidersFoundError` if the imports walk yields more than one.
   */
  #findRegistration<T>(
    token: Token,
    requestingModuleId?: string,
  ): ProviderRegistration<T> | undefined {
    // No requester OR no scope for this requester: framework-internal /
    // application-wide lookup. Prefer the `__root__` bucket so bootstrap
    // primitives win over module buckets that may hold the same token.
    if (requestingModuleId === undefined || !this.#scopes.has(requestingModuleId)) {
      const rootHit = this.#lookupInBucket<T>(ROOT_MODULE_ID, token);
      if (rootHit) return rootHit;
      const exporters = this.#exporterIndex.get(token);
      if (!exporters) return undefined;
      for (const owner of exporters) {
        const hit = this.#lookupInBucket<T>(owner, token);
        if (hit) return hit;
      }
      return undefined;
    }

    // 1. Local bucket.
    const local = this.#lookupInBucket<T>(requestingModuleId, token);
    if (local) return local;

    // 2. Global tokens: what the one @Global module exporting the token
    // provides overrides the application registration in `__root__`
    // (Reflector, ENV, NONCE_STORE, ...); two such modules are ambiguous.
    const globalExporters = this.#globals.get(token);
    if (globalExporters) {
      const candidates: ProviderRegistration<T>[] = [];
      const moduleIds: string[] = [];
      this.#collectGlobal(globalExporters, token, candidates, moduleIds);
      if (candidates.length > 1) {
        throw new MultipleProvidersFoundError(requestingModuleId, token, moduleIds);
      }
      return candidates[0];
    }

    // 3. InjectionToken with default factory — self-providing from any
    // scope. If already auto-registered (in `__root__`), return that;
    // otherwise let the caller materialize it.
    if (token instanceof InjectionToken && token.options?.factory) {
      return this.#lookupInBucket<T>(ROOT_MODULE_ID, token);
    }

    // 4. Imported modules' exports — walk transitively so re-exports work.
    const scope = this.#scopes.get(requestingModuleId);
    if (!scope) return undefined;

    const candidates: ProviderRegistration<T>[] = [];
    const candidateModuleIds: string[] = [];
    const visited = new Set<string>([requestingModuleId]);
    this.#collectFromImports<T>(scope, token, visited, candidates, candidateModuleIds);

    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) {
      throw new MultipleProvidersFoundError(requestingModuleId, token, candidateModuleIds);
    }
    return candidates[0];
  }

  /** Typed bucket lookup — single seam where the Map<Token, Registration> erases T. */
  #lookupInBucket<T>(moduleId: string, token: Token): ProviderRegistration<T> | undefined {
    return this.#providers.get(moduleId)?.get(token) as ProviderRegistration<T> | undefined;
  }

  /**
   * The registrations the given @Global modules export for a token, following
   * re-exports, or else the `__root__` one. A module that registers the token
   * without exporting it globally is not a candidate.
   */
  #collectGlobal<T>(
    importedModules: Set<string>,
    token: Token,
    candidates: ProviderRegistration<T>[],
    moduleIds: string[],
  ): void {
    this.#collectFromImports({ importedModules }, token, new Set(), candidates, moduleIds);
    const rootHit = candidates.length ? undefined : this.#lookupInBucket<T>(ROOT_MODULE_ID, token);
    if (rootHit) candidates.push(rootHit);
  }

  /**
   * Walk a scope's imports (and their imports' imports, …) collecting every
   * registration reachable through re-export chains. A child only contributes
   * if it explicitly exports the token — non-exported providers stay private.
   */
  #collectFromImports<T>(
    scope: Pick<ModuleScope, 'importedModules'>,
    token: Token,
    visited: Set<string>,
    candidates: ProviderRegistration<T>[],
    candidateModuleIds: string[],
  ): void {
    for (const importedId of scope.importedModules) {
      if (visited.has(importedId)) continue;
      visited.add(importedId);
      const imported = this.#scopes.get(importedId);
      if (!imported?.exportedTokens.has(token)) continue;

      const direct = this.#lookupInBucket<T>(importedId, token);
      if (direct) {
        candidates.push(direct);
        candidateModuleIds.push(importedId);
        continue;
      }

      // Imported module re-exports the token without owning it — recurse
      // into ITS imports.
      this.#collectFromImports<T>(imported, token, visited, candidates, candidateModuleIds);
    }
  }

  private findAllRegistrations<T>(
    token: Token,
    requestingModuleId?: string,
  ): ProviderRegistration<T>[] {
    if (requestingModuleId === undefined) {
      const exporters = this.#exporterIndex.get(token);
      if (!exporters) return [];
      return [...exporters]
        .map((id) => this.#lookupInBucket<T>(id, token))
        .filter((r): r is ProviderRegistration<T> => r !== undefined);
    }

    const out: ProviderRegistration<T>[] = [];
    const seen = new Set<ProviderRegistration<T>>();

    const local = this.#lookupInBucket<T>(requestingModuleId, token);
    if (local && !seen.has(local)) {
      out.push(local);
      seen.add(local);
    }

    const globalExporters = this.#globals.get(token);
    if (globalExporters) {
      const candidates: ProviderRegistration<T>[] = [];
      this.#collectGlobal(globalExporters, token, candidates, []);
      for (const reg of candidates) {
        if (!seen.has(reg)) {
          out.push(reg);
          seen.add(reg);
        }
      }
    }

    const scope = this.#scopes.get(requestingModuleId);
    if (scope) {
      for (const importedId of scope.importedModules) {
        const imported = this.#scopes.get(importedId);
        if (!imported?.exportedTokens.has(token)) continue;
        const reg = this.#lookupInBucket<T>(importedId, token);
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
    return this.#exporterIndex.has(token);
  }

  /** True if the specified module's bucket has a registration for `token`. */
  hasInScope(token: Token, moduleId: string): boolean {
    return this.#providers.get(moduleId)?.has(token) ?? false;
  }

  /** Module buckets that hold a registration for `token` (registration order). */
  getOwnerModuleIds(token: Token): string[] {
    return [...(this.#exporterIndex.get(token) ?? [])];
  }

  /**
   * Force-replace a provider across module scopes — the supported form of the
   * override loop test harnesses need (module-scoped resolution consults the
   * module's own bucket first, so a root-only override would never win there).
   *
   * - `'all-existing'` (default): every non-root bucket that already holds the
   *   token, plus `__root__` (so framework-internal lookups see it too).
   * - `'root'`: only the `__root__` bucket.
   * - `string[]`: exactly these bucket ids.
   */
  replaceProvider<T>(
    provider: Type<T> | ProviderDefinition<T>,
    options: { buckets?: 'all-existing' | 'root' | string[] } = {},
  ): this {
    const buckets = options.buckets ?? 'all-existing';
    if (buckets === 'root') {
      return this.register(provider);
    }
    if (Array.isArray(buckets)) {
      for (const moduleId of buckets) this.register(provider, moduleId);
      return this;
    }
    const token = typeof provider === 'function' ? provider : provider.provide;
    if (!token) {
      throw new Error('replaceProvider requires a token (`provide`)');
    }
    for (const [moduleId, bucket] of this.#providers) {
      if (moduleId === ROOT_MODULE_ID) continue;
      if (bucket.has(token)) this.register(provider, moduleId);
    }
    return this.register(provider);
  }

  /**
   * True when the token belongs exclusively to lazy modules that have not
   * been materialized yet — resolving it would trigger materialization.
   * Build-time probes (route-manager middleware priority, entrypoint
   * snapshots) use this to defer instead of forcing the group. Supplying a
   * moduleId inspects only that owner's registration, without visibility fallback.
   */
  isLazyPending(token: Token, moduleId?: string): boolean {
    const hook = this.#root.#lazyHook;
    if (!hook) return false;
    if (moduleId !== undefined) return this.hasInScope(token, moduleId) && hook.isPending(moduleId);
    const owners = this.#exporterIndex.get(token);
    if (!owners || owners.size === 0) return false;
    for (const owner of owners) {
      if (!hook.isPending(owner)) return false;
    }
    return true;
  }

  /**
   * True when any registration of the token holds a constructed instance.
   * Diagnostic helper (cold-start tests): checks WITHOUT resolving, so it
   * never triggers lazy materialization. A moduleId restricts the check to that owner.
   */
  isInstantiated(token: Token, moduleId?: string): boolean {
    if (moduleId !== undefined) {
      return this.#providers.get(moduleId)?.get(token)?.instance !== undefined;
    }
    for (const owner of this.#exporterIndex.get(token) ?? []) {
      const reg = this.#providers.get(owner)?.get(token);
      if (reg && reg.instance !== undefined) return true;
    }
    return false;
  }

  /** Declared/effective scope; a moduleId inspects that exact owner only. */
  getProviderScope(token: Token, moduleId?: string): Scope | undefined {
    if (moduleId !== undefined) {
      const registration = this.#providers.get(moduleId)?.get(token);
      return registration?.effectiveScope ?? registration?.scope;
    }
    const exporters = this.#exporterIndex.get(token);
    if (!exporters) return undefined;
    for (const owner of exporters) {
      const reg = this.#providers.get(owner)?.get(token);
      if (reg) return reg.effectiveScope ?? reg.scope;
    }
    return undefined;
  }

  /**
   * Effective scope of what `resolve(token, requestingModuleId)` would return,
   * under the requester's visibility and following `useExisting` aliases to
   * their target. Values count as singletons. `undefined` when nothing is
   * visible. Never constructs a provider or claims a lazy module.
   */
  getResolvedScope(token: Token, requestingModuleId?: string): Scope | undefined {
    let registration = this.#findRegistration(token, requestingModuleId);
    const aliases = new Set<ProviderRegistration>();
    while (registration?.useExisting && !aliases.has(registration)) {
      aliases.add(registration);
      registration = this.#findRegistration(
        registration.useExisting,
        registration.declaringModuleId,
      );
    }
    if (registration) {
      return registration.value
        ? Scope.DEFAULT
        : (registration.effectiveScope ?? registration.scope);
    }
    if (token instanceof InjectionToken && token.options?.factory) {
      return token.options.scope ?? Scope.DEFAULT;
    }
    return undefined;
  }

  private registerTokenDefault(token: InjectionToken, factory: () => unknown): void {
    this.registerOptions(
      { provide: token, useFactory: factory, scope: token.options?.scope },
      ROOT_MODULE_ID,
    );
  }

  getTokens(): Token[] {
    const out = new Set<Token>();
    for (const bucket of this.#providers.values()) {
      for (const token of bucket.keys()) out.add(token);
    }
    return [...out];
  }

  /**
   * Every statically-provided (useValue) instance across ALL module buckets.
   * Unlike resolving a token (which yields only the first bucket's registration),
   * this surfaces per-instance values — e.g. one BindingRef per multi-instance
   * binding module — so framework adapters can initialize all of them.
   */
  getUseValues(): unknown[] {
    const out: unknown[] = [];
    for (const bucket of this.#providers.values()) {
      for (const reg of bucket.values()) {
        if (reg.value) out.push(reg.value.value);
      }
    }
    return out;
  }

  /**
   * Serializable description of every loaded module instance (load order),
   * plus the `__root__` bucket (bootstrap primitives) when non-empty —
   * the `vela module graph` seam. Reads registration state only: safe pre-
   * and post-bootstrap, never constructs, never claims lazy modules.
   */
  getModuleDescriptions(): ModuleDescription[] {
    const out: ModuleDescription[] = [];
    for (const scope of this.#scopes.values()) {
      out.push({
        moduleId: scope.moduleId,
        imports: [...scope.importedModules],
        isGlobal: scope.isGlobal,
        lazy: scope.lazy === true,
        providers: [...(this.#providers.get(scope.moduleId)?.keys() ?? [])].map(describeToken),
        exports: [...scope.exportedTokens].map(describeToken),
      });
    }
    const rootBucket = this.#providers.get(ROOT_MODULE_ID);
    if (rootBucket && rootBucket.size > 0) {
      out.push({
        moduleId: ROOT_MODULE_ID,
        imports: [],
        isGlobal: false,
        lazy: false,
        providers: [...rootBucket.keys()].map(describeToken),
        exports: [],
      });
    }
    return out;
  }

  /**
   * Compute request-scope bubbling for every registration (call once at
   * bootstrap, after all providers are registered). A provider whose declared
   * scope is not REQUEST but which (transitively) depends on a request-scoped
   * provider is marked `effectiveScope = REQUEST`, so it is rebuilt per request
   * instead of capturing the first request's instance — matching NestJS.
   */
  computeEffectiveScopes(): void {
    // Reverse-propagation worklist: seed with every declared-REQUEST provider,
    // then flood "request-ness" to consumers transitively. This is order- and
    // cycle-independent (a node flips to REQUEST at most once), avoiding the
    // finalize-during-in-progress-cycle hazard of a recursive DFS.
    const regs: ProviderRegistration[] = [];
    for (const bucket of this.#providers.values()) {
      for (const reg of bucket.values()) {
        reg.effectiveScope = reg.scope;
        regs.push(reg);
      }
    }

    // Build reverse edges: dependency registration -> registrations that consume it.
    const consumers = new Map<ProviderRegistration, ProviderRegistration[]>();
    for (const reg of regs) {
      for (const depToken of this.dependencyTokensOf(reg)) {
        const depReg = this.tryFindRegistration(depToken, reg.declaringModuleId);
        if (!depReg) {
          // A token default registers on first use; a request-scoped one
          // already makes its consumers request-scoped.
          if (
            depToken instanceof InjectionToken &&
            depToken.options?.factory &&
            depToken.options.scope === Scope.REQUEST
          ) {
            reg.effectiveScope = Scope.REQUEST;
          }
          continue;
        }
        const list = consumers.get(depReg);
        if (list) list.push(reg);
        else consumers.set(depReg, [reg]);
      }
    }

    const queue = regs.filter((r) => r.effectiveScope === Scope.REQUEST);
    while (queue.length > 0) {
      const dep = queue.pop()!;
      for (const consumer of consumers.get(dep) ?? []) {
        if (consumer.effectiveScope !== Scope.REQUEST) {
          consumer.effectiveScope = Scope.REQUEST;
          queue.push(consumer);
        }
      }
    }
  }

  /** The dependency tokens a registration would resolve when constructed. */
  private dependencyTokensOf(reg: ProviderRegistration): Token[] {
    if (reg.useExisting) return [reg.useExisting];
    if (reg.useFactory) {
      return (reg.inject ?? []).map((t) => (t instanceof ForwardRef ? t.factory() : t));
    }
    const tokens: Token[] = [];
    for (const { token: raw } of reg.dependencies ?? []) {
      const token = raw instanceof ForwardRef ? raw.factory() : raw;
      if (!isErasedTypeToken(token)) tokens.push(token);
    }
    return tokens;
  }

  private tryFindRegistration(
    token: Token,
    requestingModuleId: string,
  ): ProviderRegistration | undefined {
    try {
      return this.#findRegistration(token, requestingModuleId);
    } catch {
      // Ambiguous (MultipleProvidersFoundError) or unreachable — treat as
      // unknown for scope computation; real resolution will surface any error.
      return undefined;
    }
  }

  /**
   * Create a child container for request-scoped resolution.
   * The child shares the parent's providers but caches REQUEST-scoped
   * instances separately per child (per request).
   */
  createChild(): Container {
    const child = new Container({ diagnostics: this.#diagnostics });
    // Share state by reference — request-scope children must see the same
    // module graph as the root.
    child.#providers = this.#providers;
    child.#exporterIndex = this.#exporterIndex;
    child.#scopes = this.#scopes;
    child.#globals = this.#globals;
    // Singleton disposal is owned by the root; the child keeps only its own
    // REQUEST-scoped disposables (cleared when the request ends).
    child.#root = this.#root;
    return child;
  }

  /** True when both containers belong to one root: the root itself or its request children. */
  sharesRootWith(other: Container): boolean {
    return this.#root === other.#root;
  }

  clear(): void {
    this.#providers.clear();
    this.#exporterIndex.clear();
    this.#resolutionStack.clear();
    this.#requestInstances.clear();
    this.#requestSeeds.clear();
    this.#scopes.clear();
    this.#globals.clear();
    this.#disposables.clear();
    this.#moduleRefs.clear();
    this.#reportedHiddenOptionals.clear();
  }

  /** Whether teardown has owned resources or construction to drain. */
  hasDisposables(): boolean {
    return (
      this.#disposables.size > 0 ||
      this.#pendingConstructions.size > 0 ||
      this.#disposing !== undefined
    );
  }

  #assertNotDisposing(): void {
    if (this.#disposing || this.#root.#disposing) {
      throw new Error('Cannot resolve providers while the container is disposing');
    }
  }

  private rememberCallerOwned(value: unknown): void {
    if (isReference(value) && !this.#root.#disposalOwners.has(value)) {
      this.#root.#disposalOwners.set(value, null);
    }
  }

  private trackDisposable(instance: unknown, owner: Container): void {
    if (!isReference(instance) || !isDisposable(instance)) return;
    if (this.#root.#disposalOwners.has(instance)) return;
    this.#root.#disposalOwners.set(instance, owner);
    owner.#disposables.add(instance);
  }

  /**
   * Drain owned construction, then dispose owned instances in reverse creation
   * order. Singleton graphs belong to the root; request/transient graphs belong
   * to their retaining container. Caller-owned values/seeds are never tracked.
   * Concurrent calls share teardown; after awaiting disposal the container may
   * be reused, preserving the 1.x reset semantics. Do not start new work during
   * teardown. Disposer errors are logged and do not interrupt the remaining work.
   */
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    // Schedule after installing the guard, including before user disposers run.
    const pending = Promise.resolve().then(() => this.disposeOwned());
    this.#disposing = pending.finally(() => {
      this.#disposing = undefined;
    });
    return this.#disposing;
  }

  private async disposeOwned(): Promise<void> {
    // Failed parent construction can leave sibling dependencies in flight.
    // Track every construction, including transients, independently of caching.
    while (this.#pendingConstructions.size > 0) {
      // Drain successive generations rather than abandoning late dependencies.
      // eslint-disable-next-line no-await-in-loop
      await Promise.allSettled(this.#pendingConstructions);
    }
    const pending = [...this.#disposables];
    this.#disposables.clear();
    for (let i = pending.length - 1; i >= 0; i--) {
      const instance = pending[i];
      try {
        // A consumer must finish disposing before its dependencies do.
        // eslint-disable-next-line no-await-in-loop
        await disposeInstance(instance);
      } catch (error) {
        if (this.#diagnostics !== 'silent') console.error('Error disposing instance:', error);
      } finally {
        if (isReference(instance)) this.#root.#disposalOwners.delete(instance);
      }
    }
    this.#requestInstances.clear();
    this.#requestSeeds.clear();
    if (this.#root === this) {
      for (const bucket of this.#providers.values()) {
        for (const registration of bucket.values()) {
          if (registration.scope === Scope.DEFAULT && registration.value === undefined) {
            registration.instance = undefined;
          }
        }
      }
    }
  }

  private resolveRegistration<T>(registration: ProviderRegistration<T>): T {
    if (registration.value) {
      // Deliberately BEFORE the lazy claim: reading a lazy module's useValue
      // (options tokens) has no construction cost to defer and must not
      // materialize the group.
      return registration.value.value;
    }

    // Effective scope accounts for request-scope bubbling: a singleton that
    // (transitively) depends on a request-scoped provider is treated as REQUEST
    // so it is rebuilt per request instead of capturing the first one.
    const scope = registration.effectiveScope ?? registration.scope;
    // Mirrors the REQUEST_CONTEXT guard: a request instance cached on the root
    // would outlive its request and leak into every later one.
    if (scope === Scope.REQUEST && this.#root === this) throw requestScopeOnRoot(registration);

    this.claimLazyModule(registration.declaringModuleId);

    if (registration.useExisting) {
      this.assertNoSyncCycle(registration);
      this.#resolutionStack.add(registration);
      try {
        // The requester already passed the alias visibility check. Its target
        // is part of the declaring module's wiring, just like factory inject.
        return this.#resolveToken(registration.useExisting, registration.declaringModuleId);
      } finally {
        this.#resolutionStack.delete(registration);
      }
    }

    // Singleton: return cached from registration (shared across all containers)
    if (scope === Scope.DEFAULT && registration.instance !== undefined) {
      return registration.instance.value;
    }

    // Request: return cached from this child's requestInstances
    if (scope === Scope.REQUEST) {
      const cached = (this.#requestSeeds.get(registration.provide) ??
        this.#requestInstances.get(registration)) as { readonly value: T } | undefined;
      if (cached !== undefined) {
        return cached.value;
      }
    }

    const asyncOwner = scope === Scope.DEFAULT ? this.#root : this;
    if (asyncOwner.#pendingInstances.has(registration)) {
      throw new Error(
        `Provider ${this.#tokenToString(registration.provide)} is resolving asynchronously. Use resolveAsync().`,
      );
    }

    this.assertNoSyncCycle(registration);
    this.#resolutionStack.add(registration);
    const previousOwner = this.#constructionOwner;
    const owner =
      scope === Scope.DEFAULT ? this.#root : scope === Scope.REQUEST ? this : previousOwner;
    this.#constructionOwner = owner;

    try {
      let instance: T;

      if (registration.useFactory) {
        // Factory dependencies follow the same module visibility as constructors.
        instance = this.resolveFactory(registration);
      } else if (registration.useClass) {
        instance = this.resolveClass(registration, registration.useClass);
      } else {
        throw new Error(
          `Invalid provider registration for: ${this.#tokenToString(registration.provide)}`,
        );
      }

      if (scope === Scope.DEFAULT) {
        registration.instance = { value: instance };
      } else if (scope === Scope.REQUEST) {
        this.#requestInstances.set(registration, { value: instance });
      }
      this.trackDisposable(instance, owner);

      return instance;
    } finally {
      this.#constructionOwner = previousOwner;
      this.#resolutionStack.delete(registration);
    }
  }

  private assertNoSyncCycle(registration: ProviderRegistration): void {
    if (!this.#resolutionStack.has(registration)) return;
    const chain = [...this.#resolutionStack, registration]
      .map((entry) => this.#tokenToString(entry.provide))
      .join(' -> ');
    throw new Error(`Circular dependency detected: ${chain}`);
  }

  private resolveClass<T>(registration: ProviderRegistration<T>, target: Type<T>): T {
    const ownerModuleId = registration.declaringModuleId;
    const dependencies = this.#constructorPlan(registration).map((dependency, index) => {
      const token = this.#dependencyToken(target, dependency, index);
      if (token === undefined) return undefined;
      if (dependency.optional && this.isOptionalMissing(token, ownerModuleId)) return undefined;

      // forwardRef with circular dep — break the cycle with a lazy Proxy
      if (dependency.token instanceof ForwardRef) {
        const resolved = this.#findRegistration(token, ownerModuleId);
        if (resolved && this.#resolutionStack.has(resolved)) {
          return this.createLazyProxy(token, ownerModuleId);
        }
      }

      try {
        return this.resolve(token, ownerModuleId);
      } catch (error) {
        throw this.unresolvedDependency(error, registration, target, index, token);
      }
    });

    return new target(...dependencies);
  }

  /**
   * Name the constructor whose argument has no visible provider. Only the
   * innermost class wraps: when the argument's own token is visible, the error
   * came from deeper construction and passes through unchanged.
   */
  private unresolvedDependency(
    error: unknown,
    registration: ProviderRegistration,
    target: Type,
    parameterIndex: number,
    token: Token,
  ): unknown {
    const moduleId = registration.declaringModuleId;
    if (!this.isUnresolvable(token, moduleId)) return error;
    return new UnresolvedDependencyError(
      {
        className: target.name,
        moduleId,
        parameters: this.#constructorPlan(registration).map(({ token: raw }) =>
          this.describeParameter(raw),
        ),
        parameterIndex,
        token,
        reason: this.unresolvedReason(token, moduleId),
      },
      { cause: error },
    );
  }

  // Ambiguity (MultipleProvidersFoundError) and InjectionToken default
  // factories are resolvable tokens whose own errors stay as they are.
  private isUnresolvable(token: Token, requestingModuleId: string): boolean {
    if (token === ModuleRef || (token instanceof InjectionToken && token.options?.factory)) {
      return false;
    }
    try {
      return this.#findRegistration(token, requestingModuleId) === undefined;
    } catch {
      return false;
    }
  }

  /** Built from the declarer index and the declaring modules' exported tokens. */
  private unresolvedReason(token: Token, requestingModuleId: string): UnresolvedDependencyReason {
    const declarers = [...(this.#exporterIndex.get(token) ?? [])].filter((moduleId) =>
      this.#scopes.has(moduleId),
    );
    if (!this.#scopes.has(requestingModuleId) || declarers.length === 0) {
      return { kind: 'not-provided' };
    }
    const exporters = declarers.filter((moduleId) =>
      this.#scopes.get(moduleId)?.exportedTokens.has(token),
    );
    return exporters.length > 0
      ? { kind: 'not-imported', modules: exporters }
      : { kind: 'not-exported', modules: declarers };
  }

  private describeParameter(raw: Token | ForwardRef | undefined): string {
    if (raw === undefined) return 'undefined';
    if (!(raw instanceof ForwardRef)) return describeToken(raw);
    try {
      return describeToken(raw.factory());
    } catch {
      return 'forwardRef';
    }
  }

  /** The registration-time constructor plan; every class registration carries one. */
  #constructorPlan(registration: ProviderRegistration): readonly ConstructorDependency[] {
    if (!registration.dependencies) {
      throw new Error(
        `Invalid provider registration for: ${this.#tokenToString(registration.provide)}`,
      );
    }
    return registration.dependencies;
  }

  /**
   * The token one planned parameter resolves, or undefined for an optional gap.
   * A forwardRef is evaluated here, at resolution, once every module has loaded.
   */
  #dependencyToken(
    target: Type,
    dependency: ConstructorDependency,
    index: number,
  ): Token | undefined {
    const raw = dependency.token;
    const token = raw instanceof ForwardRef ? raw.factory() : raw;
    if (!isErasedTypeToken(token)) return token;
    if (dependency.optional) return undefined;
    throw new Error(
      `Cannot resolve dependency at index ${index} for ${target.name}: its forwardRef ` +
        `returned ${token === Object ? 'Object' : String(token)}. Make sure the referenced ` +
        'class is defined and imported at runtime.',
    );
  }

  private resolveFactory<T>(registration: ProviderRegistration<T>): T {
    if (!registration.useFactory) {
      throw new Error('Factory function is missing');
    }

    const dependencies = (registration.inject || []).map((token) => {
      const resolved = token instanceof ForwardRef ? token.factory() : token;
      return this.resolve(resolved, registration.declaringModuleId);
    });
    const result = registration.useFactory(...dependencies);

    if (result instanceof Promise) {
      throw new Error(
        `Async factory for ${this.#tokenToString(registration.provide)} returned a Promise. ` +
          `Use resolveAsync() for async providers.`,
      );
    }

    return result;
  }

  resolveAsync<K extends Token>(token: K, requestingModuleId?: string): Promise<InferToken<K>>;
  async resolveAsync<T>(token: Token, requestingModuleId?: string): Promise<T> {
    this.#assertNotDisposing();
    return this.runAsyncResolution(() => this.#resolveAsyncInner<T>(token, requestingModuleId));
  }

  /**
   * Construct `type` without registering it, injecting what `requestingModuleId`
   * can see. Its dependencies belong to this container like any transient
   * resolution; each call returns a new instance owned by the caller.
   */
  async construct<T>(type: Type<T>, requestingModuleId?: string): Promise<T> {
    this.#assertNotDisposing();
    const registration: ProviderRegistration<T> = {
      provide: type,
      useClass: type,
      scope: Scope.TRANSIENT,
      declaringModuleId: requestingModuleId ?? ROOT_MODULE_ID,
      dependencies: this.#planClass(type),
    };
    return this.runAsyncResolution(() =>
      this.constructAsync(registration, new Set([registration]), this),
    );
  }

  // Lazy groups claimed during an async cascade complete once it has unwound.
  private async runAsyncResolution<T>(resolution: () => Promise<T>): Promise<T> {
    const root = this.#root;
    root.#asyncDepth++;
    let result: T;
    try {
      result = await resolution();
    } finally {
      root.#asyncDepth--;
    }
    if (root.#asyncDepth === 0 && root.#lazyHook?.hasClaimed() && !root.#lazyHook.isDraining()) {
      await root.#lazyHook.drainAsync();
    }
    return result;
  }

  async #resolveAsyncInner<T>(
    token: Token,
    requestingModuleId?: string,
    ancestors: ReadonlySet<ProviderRegistration> = new Set(),
    retainingOwner: Container = this,
  ): Promise<T> {
    if (token === ModuleRef) {
      // The ModuleRef token carries its own value type; the generic boundary erases it.
      return retainingOwner.moduleRefFor(requestingModuleId) as T;
    }
    const registration = this.#findRegistration<T>(token, requestingModuleId);
    if (!registration) {
      if (
        requestingModuleId !== undefined &&
        this.#scopes.has(requestingModuleId) &&
        this.#exporterIndex.has(token)
      ) {
        throw new ModuleVisibilityError(requestingModuleId, token);
      }
      if (token instanceof InjectionToken && token.options?.factory) {
        this.registerTokenDefault(token, token.options.factory);
        return this.#resolveAsyncInner(token, requestingModuleId, ancestors, retainingOwner);
      }
      throw new Error(
        `No provider found for token: ${this.#tokenToString(token)}. Declare it in a module's providers.`,
      );
    }
    if (registration.value) return registration.value.value;
    const scope = registration.effectiveScope ?? registration.scope;
    if (scope === Scope.REQUEST && this.#root === this) throw requestScopeOnRoot(registration);
    if (ancestors.has(registration)) {
      const chain = [...ancestors, registration]
        .map((entry) => this.#tokenToString(entry.provide))
        .join(' -> ');
      throw new Error(`Circular dependency detected: ${chain}`);
    }
    const next = new Set([...ancestors, registration]);
    this.claimLazyModule(registration.declaringModuleId);
    if (registration.useExisting) {
      return this.#resolveAsyncInner(
        registration.useExisting,
        registration.declaringModuleId,
        next,
        retainingOwner,
      );
    }
    if (scope === Scope.DEFAULT && registration.instance) return registration.instance.value;
    if (scope === Scope.REQUEST) {
      // This cache is written only through checked token values or this same registration.
      const cached = (this.#requestSeeds.get(registration.provide) ??
        this.#requestInstances.get(registration)) as { readonly value: T } | undefined;
      if (cached) return cached.value;
    }
    const owner =
      scope === Scope.DEFAULT ? this.#root : scope === Scope.REQUEST ? this : retainingOwner;
    if (scope !== Scope.TRANSIENT) {
      // In-flight entries share the registration's value type, erased by the heterogeneous map.
      const pending = owner.#pendingInstances.get(registration) as Promise<T> | undefined;
      if (pending) return pending;
    }
    const pending = this.constructAsync(registration, next, owner).then((instance) => {
      if (scope === Scope.DEFAULT) {
        registration.instance = { value: instance };
      } else if (scope === Scope.REQUEST) {
        this.#requestInstances.set(registration, { value: instance });
      }
      this.trackDisposable(instance, owner);
      return instance;
    });
    owner.#pendingConstructions.add(pending);
    if (scope !== Scope.TRANSIENT) owner.#pendingInstances.set(registration, pending);
    try {
      return await pending;
    } finally {
      owner.#pendingConstructions.delete(pending);
      if (owner.#pendingInstances.get(registration) === pending)
        owner.#pendingInstances.delete(registration);
    }
  }

  private async constructAsync<T>(
    registration: ProviderRegistration<T>,
    ancestors: ReadonlySet<ProviderRegistration>,
    owner: Container,
  ): Promise<T> {
    const moduleId = registration.declaringModuleId;
    if (registration.useFactory) {
      const dependencies = await Promise.all(
        (registration.inject ?? []).map((token) =>
          this.#resolveAsyncInner(
            token instanceof ForwardRef ? token.factory() : token,
            moduleId,
            ancestors,
            owner,
          ),
        ),
      );
      return registration.useFactory(...dependencies);
    }
    const target = registration.useClass;
    if (!target)
      throw new Error(
        `Invalid provider registration for: ${this.#tokenToString(registration.provide)}`,
      );
    const dependencies = await Promise.all(
      this.#constructorPlan(registration).map(async (dependency, index) => {
        const token = this.#dependencyToken(target, dependency, index);
        if (token === undefined) return undefined;
        if (dependency.optional && this.isOptionalMissing(token, moduleId)) return undefined;
        if (dependency.token instanceof ForwardRef) {
          const resolved = this.#findRegistration(token, moduleId);
          if (resolved && ancestors.has(resolved)) return this.createLazyProxy(token, moduleId);
        }
        try {
          return await this.#resolveAsyncInner(token, moduleId, ancestors, owner);
        } catch (error) {
          throw this.unresolvedDependency(error, registration, target, index, token);
        }
      }),
    );
    return new target(...dependencies);
  }

  private moduleRefFor(requestingModuleId: string | undefined): ModuleRef {
    const moduleId = requestingModuleId ?? ROOT_MODULE_ID;
    let moduleRef = this.#moduleRefs.get(moduleId);
    if (!moduleRef) {
      moduleRef = new ModuleRef(this, moduleId);
      this.#moduleRefs.set(moduleId, moduleRef);
    }
    return moduleRef;
  }

  /**
   * `@Optional()` injects `undefined` only when nothing is registered for the
   * token. A provider another module registers without exposing it to the
   * requester is a wiring mistake, reported through the diagnostics policy.
   */
  private isOptionalMissing(token: Token, requestingModuleId: string): boolean {
    if (token === ModuleRef || this.#findRegistration(token, requestingModuleId)) return false;
    if (this.#scopes.has(requestingModuleId) && this.#exporterIndex.has(token)) {
      this.reportHiddenOptional(token, requestingModuleId);
      return true;
    }
    return !(token instanceof InjectionToken && token.options?.factory);
  }

  private reportHiddenOptional(token: Token, requestingModuleId: string): void {
    const error = new ModuleVisibilityError(requestingModuleId, token);
    if (this.#diagnostics === 'throw') throw error;
    if (this.#diagnostics === 'silent') return;
    const reported = this.#root.#reportedHiddenOptionals;
    const modules = reported.get(token) ?? new Set<string>();
    if (modules.has(requestingModuleId)) return;
    modules.add(requestingModuleId);
    reported.set(token, modules);
    console.warn(`[vela] @Optional() dependency injected as undefined. ${error.message}`);
  }

  private createLazyProxy(token: Token, requestingModuleId?: string): object {
    const target: object = Object.create(null);
    return new Proxy(target, {
      get: (_target, prop) => {
        const instance = this.resolve(token, requestingModuleId);
        if ((typeof instance !== 'object' || instance === null) && typeof instance !== 'function') {
          throw new Error('A circular dependency must resolve to an object');
        }
        // Annotate `unknown` to contain `Reflect.get`'s `any` return so the
        // typeof-narrows-to-Function guard below stays honest.
        const value: unknown = Reflect.get(instance, prop, instance);
        return typeof value === 'function' ? value.bind(instance) : value;
      },
      set: (_target, prop, value) => {
        const instance = this.resolve(token, requestingModuleId);
        if ((typeof instance !== 'object' || instance === null) && typeof instance !== 'function') {
          throw new Error('A circular dependency must resolve to an object');
        }
        // `Reflect.set` returns whether the assignment succeeded — that's the
        // spec-correct Proxy `set` return, vs returning `true` unconditionally.
        return Reflect.set(instance, prop, value);
      },
    });
  }

  #tokenToString(token: Token): string {
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
