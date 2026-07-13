import { Scope } from '../constants';
import { disposeInstance, isDisposable } from './disposable';
import {
  getConstructorDependencies,
  getInjectMetadata,
  getScope,
  isInjectable,
} from './decorators';
import type {
  ContainerOptions,
  Diagnostics,
  LazyResolutionHook,
  ModuleDescription,
  ModuleScope,
  ProviderOptions,
  ProviderRegistration,
  Token,
  Type,
} from './types';
import {
  describeToken,
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
  // The root container that owns shared state; a request child points back here
  // so container-constructed SINGLETONs are tracked (and disposed) at the root,
  // never by the ephemeral child that happened to first resolve them.
  private root: Container = this;
  // Container-constructed instances in creation order, for LIFO disposal.
  // useValue providers are never tracked (they return before construction).
  private disposables: unknown[] = [];
  // Lazy-module seam (root-owned; children reach it via this.root). A
  // resolution of a deferred registration CLAIMS its module; claimed groups
  // are completed (constructed + hooks replayed) only when the resolution
  // stack has unwound and no resolveAsync cascade is in flight — running the
  // replay mid-construction could force-resolve a class currently on the
  // resolution stack (discovery cascades) and mint a spurious
  // circular-dependency error.
  private lazyHook?: LazyResolutionHook;
  private asyncDepth = 0;

  constructor(options: ContainerOptions = {}) {
    this.diagnostics = options.diagnostics ?? 'log';
  }

  /** Install the lazy-module seam (bootstrap-time; root container only). */
  setLazyHook(hook: LazyResolutionHook): void {
    this.root.lazyHook = hook;
  }

  private claimLazyModule(declaringModuleId: string): void {
    const hook = this.root.lazyHook;
    if (hook?.isPending(declaringModuleId)) {
      hook.claim(declaringModuleId);
    }
  }

  private maybeDrainSync(): void {
    const root = this.root;
    const hook = root.lazyHook;
    if (!hook?.hasClaimed()) return;
    // Never replay hooks while construction is in flight; an async cascade
    // drains (with await) at its own end instead. A running drain picks
    // pending claims up itself — re-entering it is at best a no-op and on
    // the async path a self-deadlock.
    if (this.resolutionStack.size > 0) return;
    if (root.asyncDepth > 0) return;
    if (hook.isDraining()) return;
    hook.drainSync();
  }

  register<T>(provider: Type<T> | ProviderOptions<T>, declaringModuleId?: string): this {
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
      const instance = this.resolveRegistration(registration, requestingModuleId);
      this.maybeDrainSync();
      return instance;
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
        `No provider found for token: ${this.tokenToString(token)}. ` + IMPORT_TYPE_HINT,
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
    const instances = registrations.map((r) => this.resolveRegistration(r, requestingModuleId));
    this.maybeDrainSync();
    return instances;
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
          throw new MultipleProvidersFoundError(requestingModuleId, token, [...exporters]);
        }
        const [owner] = [...exporters];
        return this.lookupInBucket<T>(owner!, token);
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
      throw new MultipleProvidersFoundError(requestingModuleId, token, candidateModuleIds);
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
      this.collectFromImports<T>(imported, token, visited, candidates, candidateModuleIds);
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

  /** Module buckets that hold a registration for `token` (registration order). */
  getOwnerModuleIds(token: Token): string[] {
    return [...(this.exporterIndex.get(token) ?? [])];
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
    provider: Type<T> | ProviderOptions<T>,
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
    for (const [moduleId, bucket] of this.providers) {
      if (moduleId === ROOT_MODULE_ID) continue;
      if (bucket.has(token)) this.register(provider, moduleId);
    }
    return this.register(provider);
  }

  /**
   * True when the token belongs exclusively to lazy modules that have not
   * been materialized yet — resolving it would trigger materialization.
   * Build-time probes (route-manager middleware priority, entrypoint
   * snapshots) use this to defer instead of forcing the group.
   */
  isLazyPending(token: Token): boolean {
    const hook = this.root.lazyHook;
    if (!hook) return false;
    const owners = this.exporterIndex.get(token);
    if (!owners || owners.size === 0) return false;
    for (const owner of owners) {
      if (!hook.isPending(owner)) return false;
    }
    return true;
  }

  /**
   * True when any registration of the token holds a constructed instance.
   * Diagnostic helper (cold-start tests): checks WITHOUT resolving, so it
   * never triggers lazy materialization.
   */
  isInstantiated(token: Token): boolean {
    for (const owner of this.exporterIndex.get(token) ?? []) {
      const reg = this.providers.get(owner)?.get(token);
      if (reg && reg.instance !== undefined) return true;
    }
    return false;
  }

  getProviderScope(token: Token): Scope | undefined {
    const exporters = this.exporterIndex.get(token);
    if (!exporters) return undefined;
    for (const owner of exporters) {
      const reg = this.providers.get(owner)?.get(token);
      if (reg) return reg.effectiveScope ?? reg.scope;
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
   * Every statically-provided (useValue) instance across ALL module buckets.
   * Unlike resolving a token (which yields only the first bucket's registration),
   * this surfaces per-instance values — e.g. one BindingRef per multi-instance
   * binding module — so framework adapters can initialize all of them.
   */
  getUseValues(): unknown[] {
    const out: unknown[] = [];
    for (const bucket of this.providers.values()) {
      for (const reg of bucket.values()) {
        if (reg.useValue !== undefined) out.push(reg.useValue);
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
    for (const scope of this.scopes.values()) {
      out.push({
        moduleId: scope.moduleId,
        imports: [...scope.importedModules],
        isGlobal: scope.isGlobal,
        lazy: scope.lazy === true,
        providers: [...(this.providers.get(scope.moduleId)?.keys() ?? [])].map(describeToken),
        exports: [...scope.exportedTokens].map(describeToken),
      });
    }
    const rootBucket = this.providers.get(ROOT_MODULE_ID);
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
    for (const bucket of this.providers.values()) {
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
        if (!depReg) continue;
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
    const cls =
      reg.useClass ?? (typeof reg.provide === 'function' ? (reg.provide as Type) : undefined);
    if (!cls) return [];

    const paramTypes = getConstructorDependencies(cls);
    const injectMetadata = getInjectMetadata(cls);
    const injectMap = new Map(injectMetadata.map((m) => [m.index, m]));
    const arity = Math.max(
      paramTypes.length,
      injectMetadata.reduce((max, m) => Math.max(max, m.index + 1), 0),
    );

    const tokens: Token[] = [];
    for (let i = 0; i < arity; i++) {
      const raw = injectMap.get(i)?.token;
      const token = raw instanceof ForwardRef ? raw.factory() : (raw ?? paramTypes[i]);
      if (token && !isErasedTypeToken(token)) tokens.push(token);
    }
    return tokens;
  }

  private tryFindRegistration(
    token: Token,
    requestingModuleId: string,
  ): ProviderRegistration | undefined {
    try {
      return this.findRegistration(token, requestingModuleId);
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
    const child = new Container({ diagnostics: this.diagnostics });
    // Share state by reference — request-scope children must see the same
    // module graph as the root.
    child.providers = this.providers;
    child.exporterIndex = this.exporterIndex;
    child.scopes = this.scopes;
    child.globals = this.globals;
    // SINGLETON disposal is owned by the root; the child keeps only its own
    // REQUEST-scoped disposables (cleared when the request ends).
    child.root = this.root;
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
    // Registration objects are shallow-shared, so a sandbox resolve of a lazy
    // module's singleton caches onto the SHARED registration. Point the
    // sandbox at the real root so that resolution claims the module and
    // replays its hooks like any other trigger — otherwise ModuleRef.create
    // would leave a hook-less instance poisoning the shared cache (and its
    // disposables tracked on an ephemeral root).
    child.root = this.root;
    return child;
  }

  clear(): void {
    this.providers.clear();
    this.exporterIndex.clear();
    this.resolutionStack.clear();
    this.requestInstances.clear();
    this.scopes.clear();
    this.globals.clear();
    this.disposables = [];
  }

  /** Whether this container has any tracked disposables (cheap request-path check). */
  hasDisposables(): boolean {
    return this.disposables.length > 0;
  }

  /**
   * Dispose container-constructed instances (Symbol.asyncDispose /
   * Symbol.dispose / .dispose()) in reverse creation order (LIFO). Errors are
   * logged and skipped so one bad teardown never blocks the rest.
   *
   * A REQUEST child disposes only its own request-scoped instances; the root
   * disposes shared SINGLETONs and clears their cached instance so a dev HMR
   * generation cannot leak a stale graph. Shared provider maps are left intact
   * for a request child (they belong to the root).
   */
  async dispose(): Promise<void> {
    const pending = this.disposables;
    this.disposables = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      try {
        await disposeInstance(pending[i]);
      } catch (error) {
        if (this.diagnostics !== 'silent') {
          console.error('Error disposing instance:', error);
        }
      }
    }
    this.requestInstances.clear();

    if (this.root === this) {
      // Drop cached singleton instances (except useValue, which the app owns)
      // so a rebuilt graph starts clean.
      for (const bucket of this.providers.values()) {
        for (const registration of bucket.values()) {
          if (registration.scope === Scope.SINGLETON && registration.useValue === undefined) {
            registration.instance = undefined;
          }
        }
      }
    }
  }

  private resolveRegistration<T>(
    registration: ProviderRegistration<T>,
    requestingModuleId?: string,
  ): T {
    if (registration.useValue !== undefined) {
      // Deliberately BEFORE the lazy claim: reading a lazy module's useValue
      // (options tokens) has no construction cost to defer and must not
      // materialize the group.
      return registration.useValue;
    }

    this.claimLazyModule(registration.declaringModuleId);

    if (registration.useExisting) {
      // Pass through the original requester to catch alias leaks
      return this.resolve(registration.useExisting, requestingModuleId);
    }

    // Effective scope accounts for request-scope bubbling: a SINGLETON that
    // (transitively) depends on a request-scoped provider is treated as REQUEST
    // so it is rebuilt per request instead of capturing the first one.
    const scope = registration.effectiveScope ?? registration.scope;

    // Singleton: return cached from registration (shared across all containers)
    if (scope === Scope.SINGLETON && registration.instance !== undefined) {
      return registration.instance;
    }

    // Request: return cached from this child's requestInstances
    if (scope === Scope.REQUEST) {
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
        // Factory inject deps resolve from the declaring module's scope first
        // (visibility-correct for forRootAsync), with the legacy no-requester
        // lookup kept as fallback — see resolveFactoryDependency.
        instance = this.resolveFactory(registration);
      } else if (registration.useClass) {
        instance = this.resolveClass(registration.useClass, registration.declaringModuleId);
      } else {
        throw new Error(
          `Invalid provider registration for: ${this.tokenToString(registration.provide)}`,
        );
      }

      if (scope === Scope.SINGLETON) {
        registration.instance = instance;
        // Track for disposal on the ROOT — a singleton outlives the request
        // child that may have first constructed it.
        if (isDisposable(instance)) this.root.disposables.push(instance);
      } else if (scope === Scope.REQUEST) {
        this.requestInstances.set(registration.provide, instance);
        if (isDisposable(instance)) this.disposables.push(instance);
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

    // Constructor arity. Normally `design:paramtypes` (emitDecoratorMetadata)
    // gives the count, but some bundlers — notably esbuild (and therefore
    // Wrangler) — do not emit it, leaving `paramTypes` empty even when
    // `@Inject(token)` recorded explicit tokens. Fall back to the highest
    // `@Inject` index so explicit-token constructors still resolve without
    // emitted metadata. Slots with neither a param type nor an `@Inject` token
    // still hit the unresolved-dependency error below.
    const arity = Math.max(
      paramTypes.length,
      injectMetadata.reduce((max, m) => Math.max(max, m.index + 1), 0),
    );

    const dependencies = Array.from({ length: arity }, (_unused, index) => {
      const paramType = paramTypes[index];
      const meta = injectMap.get(index);
      const rawToken = meta?.token;
      const isForwardRef = rawToken instanceof ForwardRef;
      const token: Token | undefined = isForwardRef ? rawToken.factory() : (rawToken ?? paramType);

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

  /**
   * Resolve one factory `inject` dependency. Since 1.11 the declaring module's
   * scope is consulted FIRST (proper visibility semantics — a `forRootAsync`
   * factory can inject providers reachable through its module's imports); on
   * any failure the legacy no-requester lookup (root bucket, then first
   * exporter) is kept as fallback, so every previously-resolving graph still
   * resolves.
   */
  private resolveFactoryDependency(token: Token, declaringModuleId: string): unknown {
    if (declaringModuleId !== ROOT_MODULE_ID && this.scopes.has(declaringModuleId)) {
      try {
        return this.resolve(token, declaringModuleId);
      } catch {
        // Fall through to the legacy escape hatch below.
      }
    }
    return this.resolve(token);
  }

  private async resolveFactoryDependencyAsync(
    token: Token,
    declaringModuleId: string,
  ): Promise<unknown> {
    if (declaringModuleId !== ROOT_MODULE_ID && this.scopes.has(declaringModuleId)) {
      try {
        return await this.resolveAsync(token, declaringModuleId);
      } catch {
        // Fall through to the legacy escape hatch below.
      }
    }
    return this.resolveAsync(token);
  }

  private resolveFactory<T>(registration: ProviderRegistration<T>): T {
    if (!registration.useFactory) {
      throw new Error('Factory function is missing');
    }

    const dependencies = (registration.inject || []).map((token) => {
      const resolved = token instanceof ForwardRef ? token.factory() : token;
      return this.resolveFactoryDependency(resolved, registration.declaringModuleId);
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
    const root = this.root;
    root.asyncDepth++;
    let result: T;
    try {
      result = await this.resolveAsyncInner<T>(token, requestingModuleId);
    } finally {
      root.asyncDepth--;
    }
    if (root.asyncDepth === 0 && root.lazyHook?.hasClaimed() && !root.lazyHook.isDraining()) {
      await root.lazyHook.drainAsync();
    }
    return result;
  }

  private async resolveAsyncInner<T>(token: Token<T>, requestingModuleId?: string): Promise<T> {
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
      const scope = registration.effectiveScope ?? registration.scope;
      if (scope === Scope.SINGLETON && registration.instance !== undefined) {
        return registration.instance;
      }

      this.claimLazyModule(registration.declaringModuleId);

      // Module scope first, legacy no-requester fallback — same policy as the
      // sync resolveFactory path.
      const dependencies = await Promise.all(
        (registration.inject || []).map((t) => {
          const resolved = t instanceof ForwardRef ? t.factory() : t;
          return this.resolveFactoryDependencyAsync(resolved, registration.declaringModuleId);
        }),
      );

      const instance = await registration.useFactory(...dependencies);

      if (scope === Scope.SINGLETON) {
        registration.instance = instance;
        // Track for disposal on the ROOT, matching the sync resolveRegistration path.
        if (isDisposable(instance)) this.root.disposables.push(instance);
      }

      return instance;
    }

    return this.resolve(token, requestingModuleId);
  }

  private createLazyProxy(token: Token, requestingModuleId?: string): object {
    const container = this;
    const target: object = Object.create(null);
    return new Proxy(target, {
      get(_target, prop) {
        const instance = container.resolve<object>(token, requestingModuleId);
        // Annotate `unknown` to contain `Reflect.get`'s `any` return so the
        // typeof-narrows-to-Function guard below stays honest.
        const value: unknown = Reflect.get(instance, prop, instance);
        return typeof value === 'function' ? value.bind(instance) : value;
      },
      set(_target, prop, value) {
        const instance = container.resolve<object>(token, requestingModuleId);
        // `Reflect.set` returns whether the assignment succeeded — that's the
        // spec-correct Proxy `set` return, vs returning `true` unconditionally.
        return Reflect.set(instance, prop, value);
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
