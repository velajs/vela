import { Scope } from '../constants';
import type { Container } from '../container/container';
import { reportDiagnostic } from '../container/diagnostics';
import {
  ForwardRef,
  defineProvider,
  describeToken,
  getProviderOptions,
  InjectionToken,
  isProviderDefinition,
  toProviderDefinition,
} from '../container/types';
import type { Provider, ProviderDefinition, Token, TypedToken, Type } from '../container/types';
import type { RouteManager } from '../http/route.manager';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from '../pipeline/tokens';
import { getScope, isDecoratedClass, planConstructor } from '../container/decorators';
import { MetadataRegistry } from '../registry/metadata.registry';
import { getOrCreateArray } from '../registry/util';
import type { ComponentInstance, DynamicModule, ModuleImport } from '../registry/types';
import { getModuleMetadata, isModule } from './decorators';
import { LazyModuleManager } from './lazy-modules';
import { MiddlewareBuilder } from './middleware';
import type { MiddlewareRouteDefinition, NestModule } from './middleware';

import {
  DEFAULT_MODULE_KEY,
  assertDefinedEntries,
  isDynamicModule,
  moduleKeyOf,
  readModuleIdentity,
  unwrapModuleImport,
  type ModuleIdentityComparer,
} from './module-identity';

const APP_TOKENS = new Set<Token>([
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
]);

const ENHANCER_TYPES = ['guard', 'pipe', 'interceptor', 'filter'] as const;

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

function implementsNestModule(cls: Type): cls is Type<NestModule> {
  // `Type.prototype` is `any` — direct property access is type-safe enough.
  return typeof cls.prototype?.configure === 'function';
}

function tokenOfProvider(provider: Type | ProviderDefinition): Token | undefined {
  return typeof provider === 'function' ? provider : provider.provide;
}

export class ModuleLoader {
  // class → set of keys already processed (multi-instance dedup is by both)
  #processedModules = new Map<Type, Set<string>>();
  #processingStack = new Set<string>();
  #collectedControllers = new Set<Type>();
  #controllerOwners = new Map<Type, Set<string>>();
  // moduleId → the tokens whose instances it owns, in lifecycle-hook order:
  // providers, controllers, enhancers, then the module class, as in Nest.
  #moduleTokens = new Map<string, Token[]>();
  // (class, key) → exported tokens
  #moduleExportsCache = new Map<Type, Map<string, Set<Token>>>();
  #globalExports = new Set<Token>();
  #consumerMiddlewareDefinitions: MiddlewareRouteDefinition[] = [];
  #appProviderCounter = 0;
  #appProviderTokens = new Map<Token, Token[]>([
    [APP_GUARD, []],
    [APP_PIPE, []],
    [APP_INTERCEPTOR, []],
    [APP_FILTER, []],
    [APP_MIDDLEWARE, []],
  ]);
  // (class, key) → composed moduleId (cached for stable identity within a load)
  #moduleIdByClassKey = new Map<Type, Map<string, string>>();
  #seenModuleIds = new Set<string>();
  // Lazy (deferred-init) module instances: moduleId → its own tokens in
  // registration order. Consumed by LazyModuleManager via getLazyGroups().
  #lazyGroups = new Map<string, LazyModuleGroupSpec>();
  // moduleId → controllers it declares; the same Set backs the container's
  // ModuleScope, which pipelines read to apply module-level @Use* components.
  #moduleControllers = new Map<string, Set<Type>>();
  // Per-load reference ids: identity fingerprints never outlive this loader.
  // Created by the first recorded identity that needs comparing.
  #identity?: ModuleIdentityComparer;
  // moduleId → the DynamicModule that first created the instance, compared
  // against later imports of the same (class, key).
  #definitionByModuleId = new Map<string, DynamicModule>();
  // moduleId → classes whose @Use* and parameter-pipe class references the
  // module owns: its module class, class providers and controllers.
  #enhancerHosts = new Map<string, Set<Type>>();

  constructor(
    private container: Container,
    private router: RouteManager,
  ) {}

  load(rootModule: Type | DynamicModule): void {
    this.processModule(rootModule);
    // After every module loaded, so visibility includes all global exports.
    this.registerEnhancers();

    for (const controller of this.#collectedControllers) {
      for (const moduleId of this.#controllerOwners.get(controller) ?? []) {
        this.router.registerController(controller, moduleId);
      }
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
    let perClass = this.#moduleIdByClassKey.get(moduleClass);
    if (perClass) {
      const cached = perClass.get(key);
      if (cached) return cached;
    } else {
      perClass = new Map();
      this.#moduleIdByClassKey.set(moduleClass, perClass);
    }

    const baseName = moduleClass.name || 'AnonModule';
    let id = `${baseName}#${key}`;
    let counter = 0;
    // Cross-class name collision (rare): two different classes named identically.
    // The (class, key) pair identifies us; bump suffix to keep `id` strings unique
    // in `seenModuleIds` so debug output stays unambiguous.
    while (this.#seenModuleIds.has(id)) {
      id = `${baseName}#${key}~${++counter}`;
    }
    this.#seenModuleIds.add(id);
    perClass.set(key, id);
    return id;
  }

  private isProcessed(moduleClass: Type, key: string): boolean {
    return this.#processedModules.get(moduleClass)?.has(key) ?? false;
  }

  private markProcessed(moduleClass: Type, key: string): void {
    let keys = this.#processedModules.get(moduleClass);
    if (!keys) {
      keys = new Set();
      this.#processedModules.set(moduleClass, keys);
    }
    keys.add(key);
  }

  private getCachedExports(moduleClass: Type, key: string): Set<Token> | undefined {
    return this.#moduleExportsCache.get(moduleClass)?.get(key);
  }

  private cacheExports(moduleClass: Type, key: string, exports: Set<Token>): void {
    let perClass = this.#moduleExportsCache.get(moduleClass);
    if (!perClass) {
      perClass = new Map();
      this.#moduleExportsCache.set(moduleClass, perClass);
    }
    perClass.set(key, exports);
  }

  private processModule(moduleClassOrDynamic: Type | DynamicModule): Set<Token> {
    let moduleClass: Type;
    let extraImports: ModuleImport[] = [];
    let extraControllers: Type[] = [];
    let extraProviders: Provider[] = [];
    let extraExports: Token[] = [];
    let key: string = DEFAULT_MODULE_KEY;

    if (isDynamicModule(moduleClassOrDynamic)) {
      moduleClass = moduleClassOrDynamic.module;
      extraImports = moduleClassOrDynamic.imports ?? [];
      extraControllers = moduleClassOrDynamic.controllers ?? [];
      extraProviders = moduleClassOrDynamic.providers ?? [];
      extraExports = moduleClassOrDynamic.exports ?? [];
      key = moduleClassOrDynamic.key ?? DEFAULT_MODULE_KEY;
    } else {
      moduleClass = moduleClassOrDynamic;
    }

    const moduleId = this.getModuleId(moduleClass, key);
    if (this.isProcessed(moduleClass, key)) {
      const accepted = this.reportIdentityCollision(moduleId, moduleClass, moduleClassOrDynamic);
      // A hand-written repeat may still add controllers to the instance. A
      // generated module's controllers came from the setup of the repeat's own
      // definition, which the first one replaces: another call builds new
      // controller classes, and a conflicting one never reaches this point.
      if (accepted && !readModuleIdentity(moduleClassOrDynamic)) {
        for (const controller of extraControllers) {
          if (this.registerController(controller, moduleId)) {
            this.#moduleControllers.get(moduleId)?.add(controller);
            this.#enhancerHosts.get(moduleId)?.add(controller);
            this.#moduleTokens.get(moduleId)?.push(controller);
          }
        }
      }
      return this.getCachedExports(moduleClass, key) ?? new Set();
    }

    if (this.#processingStack.has(moduleId)) {
      const chain = [...this.#processingStack, moduleId].join(' -> ');
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

    const allImports = [...metadata.imports, ...extraImports];
    const listedProviders = [...metadata.providers, ...extraProviders];
    const allControllers = [...metadata.controllers, ...extraControllers];
    const allExports = [...metadata.exports, ...extraExports];
    const moduleName = moduleClass.name || 'AnonModule';
    assertDefinedEntries(moduleName, 'imports', allImports);
    assertDefinedEntries(moduleName, 'providers', listedProviders);
    assertDefinedEntries(moduleName, 'controllers', allControllers);
    assertDefinedEntries(moduleName, 'exports', allExports);
    // Literals become checked definitions before anything reads their token.
    const allProviders = listedProviders.map((provider, index) =>
      typeof provider === 'function' || isProviderDefinition(provider)
        ? provider
        : toProviderDefinition(provider, `${moduleName}.providers[${index}]`),
    );

    // A bare class import is recorded as its plain definition, so a later
    // repeat that asks for another global flag is reported too.
    this.#definitionByModuleId.set(
      moduleId,
      isDynamicModule(moduleClassOrDynamic) ? moduleClassOrDynamic : { module: moduleClass },
    );
    this.#processingStack.add(moduleId);

    try {
      const importedProviders = new Set<Token>(this.#globalExports);

      // Determine importedModuleIds eagerly (before recursing) so child
      // modules can be referenced in our scope's importedModules set.
      const importedModuleIds = new Set<string>();

      // Track per-class keys seen in this imports array — emit a loader-time
      // diagnostic when the same module class appears under both `"default"`
      // and at least one explicit key (almost always user error).
      const keysByClassInImports = new Map<Type, Set<string>>();

      for (const entry of allImports) {
        const importedModule = unwrapModuleImport(entry);

        const importedModuleClass = isDynamicModule(importedModule)
          ? importedModule.module
          : importedModule;
        const importedKey = moduleKeyOf(importedModule);

        let keys = keysByClassInImports.get(importedModuleClass);
        if (!keys) {
          keys = new Set();
          keysByClassInImports.set(importedModuleClass, keys);
        }
        keys.add(importedKey);

        const importedId = this.getModuleId(importedModuleClass, importedKey);
        importedModuleIds.add(importedId);

        if (entry instanceof ForwardRef && this.#processingStack.has(importedId)) {
          this.reportIdentityCollision(importedId, importedModuleClass, importedModule);
          continue;
        }

        const exportedTokens = this.processModule(importedModule);
        for (const token of exportedTokens) {
          importedProviders.add(token);
        }
      }

      this.warnOnMixedDefaultAndKeyed(moduleClass.name, keysByClassInImports);

      // `exports: [ImportedModule]` re-exports what that module exports.
      const moduleExports = allExports.flatMap((exported) => {
        const keys = typeof exported === 'function' && keysByClassInImports.get(exported);
        if (!keys) return [exported];
        return [...keys].flatMap((key) => {
          const tokens = this.getCachedExports(exported, key);
          if (tokens) return [...tokens];
          throw new Error(
            `${moduleName} re-exports ${exported.name}, which it imports through a forwardRef ` +
              'cycle, so its exports are not known yet. Export those tokens directly.',
          );
        });
      });

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
        metadata.global ||
        (isDynamicModule(moduleClassOrDynamic) && moduleClassOrDynamic.global === true);

      const isLazy =
        metadata.lazy ||
        (isDynamicModule(moduleClassOrDynamic) && moduleClassOrDynamic.lazy === true);

      // Module-level Use* decorators (@UseGuards, @UseInterceptors, etc.) stay
      // on the module class; pipelines apply them to these controllers through
      // this per-app scope. Copying them onto the controllers' process-global
      // metadata would stack another copy on every bootstrap in the isolate.
      const controllers = new Set<Type>(allControllers);
      this.#moduleControllers.set(moduleId, controllers);
      const hosts = new Set<Type>([moduleClass, ...allControllers]);
      for (const provider of allProviders) {
        const host = typeof provider === 'function' ? provider : provider.useClass;
        if (host) hosts.add(host);
      }
      this.#enhancerHosts.set(moduleId, hosts);

      this.container.registerScope({
        moduleId,
        localProviders,
        importedModules: importedModuleIds,
        exportedTokens: new Set<Token>(moduleExports),
        isGlobal,
        lazy: isLazy,
        moduleClass,
        controllers,
      });

      // registerEnhancers() appends the module's enhancers and its class.
      const tokens: Token[] = [];
      this.#moduleTokens.set(moduleId, tokens);
      let hasEntrypointContributor = false;

      for (const provider of allProviders) {
        const registered = this.registerProvider(provider, moduleId);
        if (registered !== undefined) {
          tokens.push(registered);
          hasEntrypointContributor ||= declaresEntrypointContributor(provider);
        }
      }

      for (const controller of allControllers) {
        // Register the controller in its owning module's bucket so its
        // dependencies resolve from the module's POV (vs `__root__`'s).
        this.registerController(controller, moduleId);
        tokens.push(controller);
      }

      // Like Nest, the module class is a provider of its own bucket, built
      // through DI and given its lifecycle hooks after the rest of its module.
      if (!this.container.hasInScope(moduleClass, moduleId)) {
        this.container.register(moduleClass, moduleId);
      }

      if (isLazy) {
        this.#lazyGroups.set(moduleId, { moduleId, tokens, hasEntrypointContributor });
      }

      this.markProcessed(moduleClass, key);

      const exports = this.buildExportSet(
        moduleName,
        moduleExports,
        allProviders,
        importedProviders,
      );
      this.cacheExports(moduleClass, key, exports);

      if (isGlobal) {
        for (const token of exports) {
          this.#globalExports.add(token);
        }
      }

      // Call configure() if the module implements NestModule, on the module
      // instance that later receives its lifecycle hooks.
      if (implementsNestModule(moduleClass)) {
        const instance = this.container.resolve(moduleClass, moduleId);
        const builder = new MiddlewareBuilder();
        instance.configure(builder);
        this.#consumerMiddlewareDefinitions.push(
          ...builder.getDefinitions().map((definition) => ({ ...definition, moduleId })),
        );
      }

      return exports;
    } finally {
      this.#processingStack.delete(moduleId);
    }
  }

  private registerController(controller: Type, moduleId: string): boolean {
    const owners = this.#controllerOwners.get(controller) ?? new Set<string>();
    if (owners.has(moduleId)) return false;
    owners.add(moduleId);
    this.#controllerOwners.set(controller, owners);
    this.container.register(controller, moduleId);
    this.#collectedControllers.add(controller);
    return true;
  }

  /**
   * Register every guard, pipe, interceptor and filter class a module's
   * classes reference in `@Use*` or parameter decorators, in that module's
   * bucket, unless one is already visible there. Each then resolves through
   * the container from its declaring module, like a provider: once per scope,
   * with its dependencies, in its module's lazy group.
   */
  private registerEnhancers(): void {
    for (const [moduleId, hosts] of this.#enhancerHosts) {
      const tokens = this.#moduleTokens.get(moduleId) ?? [];
      for (const host of hosts) {
        const references: ComponentInstance[] = ENHANCER_TYPES.flatMap((type) =>
          MetadataRegistry.getDeclaredComponents(type, host),
        );
        for (const params of MetadataRegistry.getParameters(host).values()) {
          for (const { pipes = [] } of params) references.push(...pipes);
        }
        for (const enhancer of references) {
          if (typeof enhancer !== 'function' || this.isVisible(enhancer, moduleId)) continue;
          // An undecorated subclass inherits its parent's constructor plan and
          // scope. A class with no constructor metadata at all is built with
          // `new`, as before, but once per scope.
          this.container.register(
            isDecoratedClass(enhancer)
              ? enhancer
              : defineProvider(
                  enhancer,
                  planConstructor(enhancer).length
                    ? { useClass: enhancer }
                    : { useFactory: () => new enhancer(), scope: getScope(enhancer) },
                ),
            moduleId,
          );
          tokens.push(enhancer);
        }
      }
      // The module class, its first host, comes last.
      const [moduleClass] = hosts;
      if (moduleClass) tokens.push(moduleClass);
    }
  }

  // An ambiguous token is visible too: resolution reports it.
  private isVisible(token: Type, moduleId: string): boolean {
    try {
      return this.container.getResolvedScope(token, moduleId) !== undefined;
    } catch {
      return true;
    }
  }

  private warnOnMixedDefaultAndKeyed(
    parentName: string,
    keysByClass: Map<Type, Set<string>>,
  ): void {
    for (const [cls, keys] of keysByClass) {
      if (keys.size < 2) continue;
      if (!keys.has(DEFAULT_MODULE_KEY)) continue;
      reportDiagnostic(
        this.container.getDiagnostics(),
        `[vela] ${cls.name} imported in both bare and keyed form in '${parentName}'. ` +
          `These resolve to distinct module instances; consumers asking for an exported ` +
          `token will hit MultipleProvidersFoundError. Use one form consistently.`,
      );
    }
  }

  /**
   * A repeated (class, key) is deduplicated to its first definition. That is
   * only safe when the repeat was built from the same inputs, so a repeat
   * built from different options fails the load in every diagnostics mode:
   * keeping either configuration would run the other import's consumers on
   * options they never asked for (another base URL, driver or authorizer).
   * The options are compared first, so a global flag that differs as well
   * never hides that conflict. A repeat with the same options that asks for
   * another global flag is reported and ignored. Returns whether the repeat
   * agrees with the first definition.
   */
  private reportIdentityCollision(
    moduleId: string,
    moduleClass: Type,
    repeat: Type | DynamicModule,
  ): boolean {
    const first = this.#definitionByModuleId.get(moduleId);
    if (!first || !isDynamicModule(repeat) || first === repeat) return true;
    // Hand-written DynamicModules record no inputs, so only their global flag
    // is compared.
    const firstIdentity = readModuleIdentity(first);
    const repeatIdentity = readModuleIdentity(repeat);
    if (firstIdentity && repeatIdentity) {
      this.#identity ??= firstIdentity.createComparer();
      if (this.#identity.conflicts(firstIdentity, repeatIdentity)) {
        // Not a diagnostic: no policy may keep one configuration for both imports.
        throw new Error(
          `[vela] ${moduleId} was imported again with different options, and one module ` +
            `instance has one configuration. Import one shared definition (e.g. export a ` +
            `const of the DynamicModule) instead of building it twice, or give each ` +
            `configuration its own key (e.g. forRoot({ ..., key: 'secondary' })).`,
        );
      }
    }
    // The first definition decided whether the instance's exports are global;
    // a repeat that says otherwise would silently lose (or gain) visibility.
    // A @Global() class is global in either form.
    const classGlobal = getModuleMetadata(moduleClass)?.global === true;
    const firstGlobal = classGlobal || first.global === true;
    if (firstGlobal === (classGlobal || repeat.global === true)) return true;
    reportDiagnostic(
      this.container.getDiagnostics(),
      `[vela] ${moduleId} was imported again with a different global flag; the repeated ` +
        `import was ignored in favor of the first (global: ${firstGlobal}). ` +
        `Import the module with one global setting, or give each configuration its own key.`,
    );
    return false;
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
      const syntheticToken = new InjectionToken(
        `${token.toString()}:${this.#appProviderCounter++}`,
      );
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
              : typeof options.useExisting === 'function' ||
                  options.useExisting instanceof InjectionToken
                ? defineProvider(syntheticToken, {
                    useExisting: options.useExisting,
                    scope,
                  })
                : undefined;
      if (!syntheticProvider) throw new Error('Invalid global component provider');
      this.container.register(syntheticProvider, moduleId);
      getOrCreateArray(this.#appProviderTokens, token).push(syntheticToken);
      return syntheticToken;
    }

    this.container.register(provider, moduleId);
    return token;
  }

  private isAppToken(token: Token): boolean {
    return APP_TOKENS.has(token);
  }

  private buildExportSet(
    moduleName: string,
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
        reportDiagnostic(
          this.container.getDiagnostics(),
          `[vela] ${moduleName} exports '${describeToken(exported)}', which is neither a local ` +
            'provider nor exported by an imported module.',
        );
      }

      exportSet.add(exported);
    }

    return exportSet;
  }

  getControllers(): Type[] {
    return [...this.#collectedControllers];
  }

  getAppProviderTokens<T>(token: TypedToken<T>): TypedToken<T>[] {
    // Synthetic tokens alias registrations under this APP_* token. The map
    // erases that key/value correlation; restore it only at this boundary.
    return [...(this.#appProviderTokens.get(token) ?? [])] as TypedToken<T>[];
  }

  getConsumerMiddlewareDefinitions(): MiddlewareRouteDefinition[] {
    return [...this.#consumerMiddlewareDefinitions];
  }

  /**
   * Every lazy module instance recorded during load. Handed to the
   * LazyModuleManager at bootstrap; empty when no module opted in.
   */
  getLazyGroups(): LazyModuleGroupSpec[] {
    return [...this.#lazyGroups.values()];
  }

  // Module by module, dependencies first, each in lifecycle-hook order; every
  // keyed instance of one module class is its own module.
  async resolveAllInstances(): Promise<unknown[]> {
    const instances = new Set<unknown>();
    for (const [moduleId, tokens] of this.#moduleTokens) {
      if (this.#lazyGroups.has(moduleId)) continue;
      for (const token of tokens) {
        if (this.container.getProviderScope(token, moduleId) !== Scope.REQUEST) {
          instances.add(await this.container.resolveAsync(token, moduleId));
        }
      }
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
