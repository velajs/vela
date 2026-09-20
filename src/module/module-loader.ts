import { Scope } from '../constants';
import type { Container } from '../container/container';
import {
  ForwardRef,
  defineProvider,
  getProviderOptions,
  InjectionToken,
} from '../container/types';
import type { ProviderDefinition, Token, TypedToken, Type } from '../container/types';
import type { RouteManager } from '../http/route.manager';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from '../pipeline/tokens';
import { MetadataRegistry } from '../registry/metadata.registry';
import { getOrCreateArray } from '../registry/util';
import type { DynamicModule, ModuleImport } from '../registry/types';
import { getModuleMetadata, isModule } from './decorators';
import { LazyModuleManager } from './lazy-modules';
import { MiddlewareBuilder } from './middleware';
import type { MiddlewareRouteDefinition, NestModule } from './middleware';

const APP_TOKENS = new Set<Token>([
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
]);

const DEFAULT_KEY = 'default';

/** What the loader records per lazy module instance (see LazyModuleManager). */
export interface LazyModuleGroupSpec {
  moduleId: string;
  tokens: Token[];
  hasEntrypointContributor: boolean;
}

/**
 * Structural check for `ContributesEntrypoints` on a provider's class —
 * deliberately string-coupled to the interface's method name so the loader
 * does not import from `entrypoint/` (layering).
 */
function declaresEntrypointContributor(provider: Type | ProviderDefinition): boolean {
  const cls = typeof provider === 'function' ? provider : provider.useClass;
  if (typeof cls !== 'function') return false;
  const proto = (cls as Type).prototype as Record<string, unknown> | undefined;
  return typeof proto?.collectEntrypoints === 'function';
}

function isDynamicModule(value: unknown): value is DynamicModule {
  // TS 4.9+ narrows `'module' in value` so `value.module` is typed `unknown`
  // — no cast required for the typeof check below.
  return (
    typeof value === 'object' &&
    value !== null &&
    'module' in value &&
    typeof value.module === 'function'
  );
}

function implementsNestModule(cls: Type): cls is Type<NestModule> {
  // `Type.prototype` is `any` — direct property access is type-safe enough.
  return typeof cls.prototype?.configure === 'function';
}

function tokenOfProvider(provider: Type | ProviderDefinition): Token | undefined {
  return typeof provider === 'function' ? provider : provider.provide;
}

function keyOfImport(entry: Type | DynamicModule): string {
  return isDynamicModule(entry) ? (entry.key ?? DEFAULT_KEY) : DEFAULT_KEY;
}

/**
 * `ForwardRef.factory` is typed to return the broader `TypedToken<T>` because the
 * primitive is shared with provider injection. In module-imports position the
 * runtime contract narrows: the factory must yield a module class or a
 * `DynamicModule`. This helper validates the contract AND narrows the type
 * without a structural cast.
 */
function unwrapModuleForwardRef(ref: ForwardRef): Type | DynamicModule {
  const result = ref.factory();
  if (typeof result === 'function') return result;
  if (isDynamicModule(result)) return result;
  throw new Error(
    `forwardRef in module imports must resolve to a module class or DynamicModule; ` +
      `got ${typeof result === 'object' ? 'a non-module object' : typeof result}.`,
  );
}

export class ModuleLoader {
  // class → set of keys already processed (multi-instance dedup is by both)
  private processedModules = new Map<Type, Set<string>>();
  private processingStack = new Set<string>();
  private collectedControllers = new Set<Type>();
  private registeredProviders: Token[] = [];
  // (class, key) → exported tokens
  private moduleExportsCache = new Map<Type, Map<string, Set<Token>>>();
  private globalExports = new Set<Token>();
  private consumerMiddlewareDefinitions: MiddlewareRouteDefinition[] = [];
  private appProviderCounter = 0;
  private appProviderTokens = new Map<Token, Token[]>([
    [APP_GUARD, []],
    [APP_PIPE, []],
    [APP_INTERCEPTOR, []],
    [APP_FILTER, []],
    [APP_MIDDLEWARE, []],
  ]);
  // (class, key) → composed moduleId (cached for stable identity within a load)
  private moduleIdByClassKey = new Map<Type, Map<string, string>>();
  private seenModuleIds = new Set<string>();
  // Lazy (deferred-init) module instances: moduleId → its own tokens in
  // registration order. Consumed by LazyModuleManager via getLazyGroups().
  private lazyModuleIds = new Set<string>();
  private lazyGroups = new Map<string, LazyModuleGroupSpec>();

  constructor(
    private container: Container,
    private router: RouteManager,
  ) {}

  load(rootModule: Type): void {
    this.processModule(rootModule);

    for (const controller of this.collectedControllers) {
      this.router.registerController(controller);
    }

    // Arm the deferred-init seam HERE — at the end of load(), not in
    // bootstrap() — so every consumer of the loader gets identical lazy
    // semantics, including hand-rolled bootstrap paths that never call
    // bootstrap() (@velajs/testing's TestingModuleBuilder.compile builds its
    // own container). Still after all module-load-time resolutions
    // (NestModule.configure), so load-time resolution never claims a group.
    // Registered as a provider so VelaApplication can drive the phase
    // transitions from any of those paths.
    const lazyManager = new LazyModuleManager(this.container);
    for (const group of this.getLazyGroups()) {
      lazyManager.registerGroup(group);
    }
    this.container.setLazyHook(lazyManager);
    this.container.register(defineProvider(LazyModuleManager, { useValue: lazyManager }));
  }

  private getModuleId(moduleClass: Type, key: string): string {
    let perClass = this.moduleIdByClassKey.get(moduleClass);
    if (perClass) {
      const cached = perClass.get(key);
      if (cached) return cached;
    } else {
      perClass = new Map();
      this.moduleIdByClassKey.set(moduleClass, perClass);
    }

    const baseName = moduleClass.name || 'AnonModule';
    let id = `${baseName}#${key}`;
    let counter = 0;
    // Cross-class name collision (rare): two different classes named identically.
    // The (class, key) pair identifies us; bump suffix to keep `id` strings unique
    // in `seenModuleIds` so debug output stays unambiguous.
    while (this.seenModuleIds.has(id)) {
      id = `${baseName}#${key}~${++counter}`;
    }
    this.seenModuleIds.add(id);
    perClass.set(key, id);
    return id;
  }

  private isProcessed(moduleClass: Type, key: string): boolean {
    return this.processedModules.get(moduleClass)?.has(key) ?? false;
  }

  private markProcessed(moduleClass: Type, key: string): void {
    let keys = this.processedModules.get(moduleClass);
    if (!keys) {
      keys = new Set();
      this.processedModules.set(moduleClass, keys);
    }
    keys.add(key);
  }

  private getCachedExports(moduleClass: Type, key: string): Set<Token> | undefined {
    return this.moduleExportsCache.get(moduleClass)?.get(key);
  }

  private cacheExports(moduleClass: Type, key: string, exports: Set<Token>): void {
    let perClass = this.moduleExportsCache.get(moduleClass);
    if (!perClass) {
      perClass = new Map();
      this.moduleExportsCache.set(moduleClass, perClass);
    }
    perClass.set(key, exports);
  }

  private processModule(moduleClassOrDynamic: Type | DynamicModule): Set<Token> {
    let moduleClass: Type;
    let extraImports: ModuleImport[] = [];
    let extraControllers: Type[] = [];
    let extraProviders: Array<Type | ProviderDefinition> = [];
    let extraExports: Token[] = [];
    let key: string = DEFAULT_KEY;

    if (isDynamicModule(moduleClassOrDynamic)) {
      moduleClass = moduleClassOrDynamic.module;
      extraImports = moduleClassOrDynamic.imports ?? [];
      extraControllers = moduleClassOrDynamic.controllers ?? [];
      extraProviders = moduleClassOrDynamic.providers ?? [];
      extraExports = moduleClassOrDynamic.exports ?? [];
      key = moduleClassOrDynamic.key ?? DEFAULT_KEY;
    } else {
      moduleClass = moduleClassOrDynamic;
    }

    if (this.isProcessed(moduleClass, key)) {
      // Even if already processed, still collect extra controllers from dynamic module
      for (const controller of extraControllers) {
        this.collectedControllers.add(controller);
      }
      return this.getCachedExports(moduleClass, key) ?? new Set();
    }

    const stackKey = `${moduleClass.name}#${key}`;
    if (this.processingStack.has(stackKey)) {
      const chain = [...this.processingStack, stackKey].join(' -> ');
      throw new Error(`Circular module dependency detected: ${chain}`);
    }

    if (!isModule(moduleClass)) {
      if (isDynamicModule(moduleClassOrDynamic)) {
        MetadataRegistry.setModuleOptions(moduleClass, {});
      } else {
        throw new Error(
          `${moduleClass.name} is not a module. Add @Module() decorator to the class.`,
        );
      }
    }

    const metadata = getModuleMetadata(moduleClass);
    if (!metadata) {
      throw new Error(`Failed to get module metadata for ${moduleClass.name}`);
    }

    this.processingStack.add(stackKey);

    const moduleId = this.getModuleId(moduleClass, key);

    try {
      const importedProviders = new Set<Token>(this.globalExports);

      // Determine importedModuleIds eagerly (before recursing) so child
      // modules can be referenced in our scope's importedModules set.
      const importedModuleIds = new Set<string>();

      // Track per-class keys seen in this imports array — emit a loader-time
      // diagnostic when the same module class appears under both `"default"`
      // and at least one explicit key (almost always user error).
      const keysByClassInImports = new Map<Type, Set<string>>();

      const allImports = [...metadata.imports, ...extraImports];

      for (const entry of allImports) {
        const importedModule = entry instanceof ForwardRef ? unwrapModuleForwardRef(entry) : entry;

        const importedModuleClass = isDynamicModule(importedModule)
          ? importedModule.module
          : importedModule;
        const importedKey = keyOfImport(importedModule);

        let keys = keysByClassInImports.get(importedModuleClass);
        if (!keys) {
          keys = new Set();
          keysByClassInImports.set(importedModuleClass, keys);
        }
        keys.add(importedKey);

        const importedId = this.getModuleId(importedModuleClass, importedKey);
        importedModuleIds.add(importedId);

        const importedStackKey = `${importedModuleClass.name}#${importedKey}`;
        if (entry instanceof ForwardRef && this.processingStack.has(importedStackKey)) {
          continue;
        }

        const exportedTokens = this.processModule(importedModule);
        for (const token of exportedTokens) {
          importedProviders.add(token);
        }
      }

      this.warnOnMixedDefaultAndKeyed(moduleClass.name, keysByClassInImports);

      const allProviders = [...metadata.providers, ...extraProviders];
      const allControllers = [...metadata.controllers, ...extraControllers];
      const allExports = [...metadata.exports, ...extraExports];

      // Build the ModuleScope BEFORE registering providers so the visibility
      // check sees the local-provider set as we register.
      const localProviders = new Set<Token>();
      for (const provider of allProviders) {
        const tk = tokenOfProvider(provider);
        if (tk !== undefined) localProviders.add(tk);
      }
      for (const controller of allControllers) {
        localProviders.add(controller);
      }
      // The module class itself can be DI-resolved (NestModule.configure path);
      // include it in its own scope.
      localProviders.add(moduleClass);

      const isGlobal =
        metadata.isGlobal ||
        (isDynamicModule(moduleClassOrDynamic) && moduleClassOrDynamic.global === true);

      const isLazy =
        metadata.lazy ||
        (isDynamicModule(moduleClassOrDynamic) && moduleClassOrDynamic.lazy === true);

      this.container.registerScope({
        moduleId,
        localProviders,
        importedModules: importedModuleIds,
        exportedTokens: new Set<Token>(allExports),
        isGlobal,
        lazy: isLazy,
      });

      const lazyTokens: Token[] = [];
      let hasEntrypointContributor = false;

      for (const provider of allProviders) {
        const registered = this.registerProvider(provider, moduleId);
        if (isLazy && registered !== undefined) {
          lazyTokens.push(registered);
          hasEntrypointContributor ||= declaresEntrypointContributor(provider);
        }
      }

      for (const controller of allControllers) {
        // Register the controller in its owning module's bucket so its
        // dependencies resolve from the module's POV (vs `__root__`'s).
        this.container.register(controller, moduleId);
        this.collectedControllers.add(controller);
        if (isLazy) lazyTokens.push(controller);
      }

      if (isLazy) {
        this.lazyModuleIds.add(moduleId);
        this.lazyGroups.set(moduleId, {
          moduleId,
          tokens: lazyTokens,
          hasEntrypointContributor,
        });
      }

      // Propagate module-level Use* decorators (@UseGuards, @UseInterceptors, etc.) to each controller
      for (const controller of allControllers) {
        MetadataRegistry.propagateControllerComponents(moduleClass, controller);
      }

      this.markProcessed(moduleClass, key);

      const exports = this.buildExportSet(allExports, allProviders, importedProviders);
      this.cacheExports(moduleClass, key, exports);

      if (isGlobal) {
        for (const token of exports) {
          this.globalExports.add(token);
        }
      }

      // Call configure() if the module implements NestModule. The module is
      // resolved through the container so it can have its own DI dependencies.
      if (implementsNestModule(moduleClass)) {
        if (!this.container.hasInScope(moduleClass, moduleId)) {
          this.container.register(moduleClass, moduleId);
        }
        const instance = this.container.resolve(moduleClass, moduleId);
        const builder = new MiddlewareBuilder();
        instance.configure(builder);
        this.consumerMiddlewareDefinitions.push(...builder.getDefinitions());
      }

      return exports;
    } finally {
      this.processingStack.delete(stackKey);
    }
  }

  private warnOnMixedDefaultAndKeyed(
    parentName: string,
    keysByClass: Map<Type, Set<string>>,
  ): void {
    const mode = this.container.getDiagnostics();
    if (mode === 'silent') return;
    for (const [cls, keys] of keysByClass) {
      if (keys.size < 2) continue;
      if (!keys.has(DEFAULT_KEY)) continue;
      const message =
        `[vela] ${cls.name} imported in both bare and keyed form in '${parentName}'. ` +
        `These resolve to distinct module instances; consumers asking for an exported ` +
        `token will hit MultipleProvidersFoundError. Use one form consistently.`;
      if (mode === 'throw') throw new Error(message);
      console.warn(message);
    }
  }

  /** Registers the provider and returns the token it was registered under. */
  private registerProvider(
    provider: Type | ProviderDefinition,
    moduleId: string,
  ): Token | undefined {
    if (typeof provider === 'function') {
      // Per-module bucket: the same class can be registered in multiple
      // modules' buckets simultaneously without collision.
      this.container.register(provider, moduleId);
      this.registeredProviders.push(provider);
      return provider;
    }

    const token = provider.provide;
    if (!token) {
      this.container.register(provider, moduleId);
      return undefined;
    }

    if (this.isAppToken(token)) {
      // Multiple APP_* providers within the same module bucket need
      // distinct tokens so they don't overwrite each other in the bucket
      // Map. Across buckets, `container.resolveAll(APP_GUARD)` walks
      // every bucket — no need to mark synthetic tokens global.
      const syntheticToken = new InjectionToken(`${token.toString()}:${this.appProviderCounter++}`);
      const options = getProviderOptions(provider);
      const scope = options.scope;
      const syntheticProvider =
        'useValue' in options
          ? defineProvider(syntheticToken, { useValue: options.useValue, scope })
          : options.useClass
            ? defineProvider(syntheticToken, { useClass: options.useClass, scope })
            : options.useFactory
              ? defineProvider(syntheticToken, {
                  useFactory: options.useFactory,
                  inject: options.inject ?? [],
                  scope,
                })
              : options.useExisting
                ? defineProvider(syntheticToken, {
                    useFactory: (value) => value,
                    inject: [options.useExisting],
                    scope,
                  })
                : undefined;
      if (!syntheticProvider) throw new Error('Invalid global component provider');
      this.container.register(syntheticProvider, moduleId);
      this.registeredProviders.push(syntheticToken);
      getOrCreateArray(this.appProviderTokens, token).push(syntheticToken);
      return syntheticToken;
    }

    this.container.register(provider, moduleId);
    this.registeredProviders.push(token);
    return token;
  }

  private isAppToken(token: Token): boolean {
    return APP_TOKENS.has(token);
  }

  private buildExportSet(
    exports: Token[],
    providers: Array<Type | ProviderDefinition>,
    importedProviders: Set<Token>,
  ): Set<Token> {
    const exportSet = new Set<Token>();
    const providerTokens = new Set<Token>();
    for (const p of providers) {
      const token = tokenOfProvider(p);
      if (token !== undefined) providerTokens.add(token);
    }

    for (const exported of exports) {
      const isLocalProvider = providerTokens.has(exported);
      const isImportedProvider = importedProviders.has(exported);

      if (!isLocalProvider && !isImportedProvider) {
        const name = typeof exported === 'function' ? exported.name : String(exported);
        console.warn(
          `Warning: Exporting '${name}' which is neither a local provider nor imported from another module.`,
        );
      }

      exportSet.add(exported);
    }

    return exportSet;
  }

  getControllers(): Type[] {
    return [...this.collectedControllers];
  }

  getRegisteredProviders(): Token[] {
    return [...this.registeredProviders];
  }

  getAppProviderTokens<T>(token: TypedToken<T>): TypedToken<T>[] {
    // Synthetic tokens alias registrations under this APP_* token. The map
    // erases that key/value correlation; restore it only at this boundary.
    return [...(this.appProviderTokens.get(token) ?? [])] as TypedToken<T>[];
  }

  getConsumerMiddlewareDefinitions(): MiddlewareRouteDefinition[] {
    return [...this.consumerMiddlewareDefinitions];
  }

  /**
   * Every lazy module instance recorded during load. Handed to the
   * LazyModuleManager at bootstrap; empty when no module opted in.
   */
  getLazyGroups(): LazyModuleGroupSpec[] {
    return [...this.lazyGroups.values()];
  }

  /**
   * A token is deferred iff EVERY module bucket holding it belongs to a lazy
   * module instance — a token also registered by a non-lazy module stays on
   * the eager pass (and resolving it there claims the lazy sibling, which is
   * the "any use = init" semantic, not a bug).
   */
  private isLazyOnlyToken(token: Token): boolean {
    if (this.lazyModuleIds.size === 0) return false;
    const owners = this.container.getOwnerModuleIds(token);
    if (owners.length === 0) return false;
    return owners.every((id) => this.lazyModuleIds.has(id));
  }

  async resolveAllInstances(): Promise<unknown[]> {
    const instances = new Set<unknown>();
    for (const token of [...this.registeredProviders, ...this.collectedControllers]) {
      if (this.container.getProviderScope(token) === Scope.REQUEST || this.isLazyOnlyToken(token))
        continue;
      // Construction failures abort bootstrap. Logging and continuing would
      // leave a partial application and could repeat provider side effects.
      instances.add(await this.container.resolveAsync(token));
    }
    return [...instances];
  }

  private routeError(err: unknown, context: string): void {
    const mode = this.container.getDiagnostics();
    if (mode === 'silent') return;
    if (mode === 'throw') {
      throw err instanceof Error ? err : new Error(String(err));
    }
    console.warn(`[vela] ${context} failed:`, err);
  }
}
