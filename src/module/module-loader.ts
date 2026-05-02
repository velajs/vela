import { Scope } from "../constants";
import type { Container } from "../container/container";
import { ForwardRef, InjectionToken, ModuleVisibilityError } from "../container/types";
import type { ProviderOptions, Token, Type } from "../container/types";
import type { RouteManager } from "../http/route.manager";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from "../pipeline/tokens";
import { MetadataRegistry } from "../registry/metadata.registry";
import { getOrCreateArray } from "../registry/util";
import { getModuleMetadata, isModule } from "./decorators";
import { MiddlewareBuilder } from "./middleware";
import type { MiddlewareRouteDefinition, NestModule } from "./middleware";
import type { ModuleImport } from "./types";

const APP_TOKENS = new Set<Token>([
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
]);

interface DynamicModule {
  module: Type;
  imports?: ModuleImport[];
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  exports?: Array<Type | InjectionToken>;
  global?: boolean;
}

function isDynamicModule(value: unknown): value is DynamicModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "module" in value &&
    typeof (value as DynamicModule).module === "function"
  );
}

function implementsNestModule(cls: Type): cls is Type<NestModule> {
  return typeof (cls.prototype as Partial<NestModule> | undefined)?.configure === "function";
}

function tokenOfProvider(provider: Type | ProviderOptions): Token | undefined {
  return typeof provider === "function" ? provider : provider.provide;
}

export class ModuleLoader {
  private processedModules = new Set<Type>();
  private processingStack = new Set<Type>();
  private collectedControllers = new Set<Type>();
  private registeredProviders: Token[] = [];
  private moduleExportsCache = new Map<Type, Set<Token>>();
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
  private moduleIdByClass = new Map<Type, string>();
  private seenModuleIds = new Set<string>();

  constructor(
    private container: Container,
    private router: RouteManager,
  ) {}

  load(rootModule: Type): void {
    this.processModule(rootModule);

    for (const controller of this.collectedControllers) {
      this.router.registerController(controller);
    }
  }

  private getModuleId(moduleClass: Type): string {
    const cached = this.moduleIdByClass.get(moduleClass);
    if (cached) return cached;
    const baseName = moduleClass.name || "AnonModule";
    let id = baseName;
    let counter = 0;
    while (this.seenModuleIds.has(id)) {
      id = `${baseName}#${++counter}`;
    }
    this.seenModuleIds.add(id);
    this.moduleIdByClass.set(moduleClass, id);
    return id;
  }

  private processModule(
    moduleClassOrDynamic: Type | DynamicModule,
  ): Set<Token> {
    // Handle dynamic modules ({ module, imports, controllers, providers })
    let moduleClass: Type;
    let extraImports: ModuleImport[] = [];
    let extraControllers: Type[] = [];
    let extraProviders: Array<Type | ProviderOptions> = [];
    let extraExports: Array<Type | InjectionToken> = [];

    if (isDynamicModule(moduleClassOrDynamic)) {
      moduleClass = moduleClassOrDynamic.module;
      extraImports = moduleClassOrDynamic.imports ?? [];
      extraControllers = moduleClassOrDynamic.controllers ?? [];
      extraProviders = moduleClassOrDynamic.providers ?? [];
      extraExports = moduleClassOrDynamic.exports ?? [];
    } else {
      moduleClass = moduleClassOrDynamic;
    }

    if (this.processedModules.has(moduleClass)) {
      // Even if already processed, still collect extra controllers from dynamic module
      for (const controller of extraControllers) {
        this.collectedControllers.add(controller);
      }
      return this.moduleExportsCache.get(moduleClass) ?? new Set();
    }

    if (this.processingStack.has(moduleClass)) {
      const chain = [...this.processingStack, moduleClass]
        .map((m) => m.name)
        .join(" -> ");
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

    this.processingStack.add(moduleClass);

    const moduleId = this.getModuleId(moduleClass);

    try {
      const importedProviders = new Set<Token>(this.globalExports);

      // Determine importedModuleIds eagerly (before recursing) so child
      // modules can be referenced in our scope's importedModules set.
      const importedModuleIds = new Set<string>();

      for (const entry of [...metadata.imports, ...extraImports]) {
        // Unwrap forwardRef(() => Module) — resolves lazy circular references
        const isForwardRef = entry instanceof ForwardRef;
        const importedModule = isForwardRef
          ? (entry.factory() as Type | DynamicModule)
          : (entry as Type | DynamicModule);

        const importedModuleClass = isDynamicModule(importedModule)
          ? importedModule.module
          : (importedModule as Type);

        importedModuleIds.add(this.getModuleId(importedModuleClass));

        // If this forwardRef-wrapped import is currently being processed, skip it to
        // break the circular chain. Non-forwardRef circular imports still throw.
        if (isForwardRef && this.processingStack.has(importedModuleClass)) {
          continue;
        }

        const exportedTokens = this.processModule(importedModule);
        for (const token of exportedTokens) {
          importedProviders.add(token);
        }
      }

      const allProviders = [...metadata.providers, ...extraProviders];
      const allControllers = [...metadata.controllers, ...extraControllers];
      const allExports = [...metadata.exports, ...extraExports];

      // Build the ModuleScope BEFORE registering providers so the visibility
      // check (in strict mode) can see the local-provider set as we register.
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
        (isDynamicModule(moduleClassOrDynamic) &&
          moduleClassOrDynamic.global === true);

      this.container.registerScope({
        moduleId,
        localProviders,
        importedModules: importedModuleIds,
        exportedTokens: new Set<Token>(allExports as Token[]),
        isGlobal,
      });

      for (const provider of allProviders) {
        this.registerProvider(provider, moduleId);
      }

      for (const controller of allControllers) {
        this.collectedControllers.add(controller);
      }

      // Propagate module-level Use* decorators (@UseGuards, @UseInterceptors, etc.) to each controller
      for (const controller of allControllers) {
        MetadataRegistry.propagateControllerComponents(moduleClass, controller);
      }

      this.processedModules.add(moduleClass);

      const exports = this.buildExportSet(
        allExports,
        allProviders,
        importedProviders,
      );
      this.moduleExportsCache.set(moduleClass, exports);

      if (isGlobal) {
        for (const token of exports) {
          this.globalExports.add(token);
        }
      }

      // Call configure() if the module implements NestModule. The module is
      // resolved through the container so it can have its own DI dependencies.
      if (implementsNestModule(moduleClass)) {
        if (!this.container.has(moduleClass)) {
          this.container.register(moduleClass, moduleId);
        }
        const instance = this.container.resolve(moduleClass, moduleId);
        const builder = new MiddlewareBuilder();
        instance.configure(builder);
        this.consumerMiddlewareDefinitions.push(...builder.getDefinitions());
      }

      return exports;
    } finally {
      this.processingStack.delete(moduleClass);
    }
  }

  private registerProvider(
    provider: Type | ProviderOptions,
    moduleId: string,
  ): void {
    if (typeof provider === "function") {
      if (!this.container.has(provider)) {
        this.container.register(provider, moduleId);
        this.registeredProviders.push(provider);
      }
    } else {
      const token = provider.provide;
      if (!token) {
        this.container.register(provider, moduleId);
        return;
      }

      if (this.isAppToken(token)) {
        const syntheticToken = new InjectionToken(
          `${token.toString()}:${this.appProviderCounter++}`,
        );
        this.container.register(
          { ...provider, provide: syntheticToken },
          moduleId,
        );
        // Synthetic APP_* tokens are resolved at request time by RouteManager
        // with no requester; mark them global so the visibility check passes.
        this.container.markGlobalToken(syntheticToken);
        this.registeredProviders.push(syntheticToken);
        getOrCreateArray(this.appProviderTokens, token).push(syntheticToken);
        return;
      }

      if (!this.container.has(token)) {
        this.container.register(provider, moduleId);
        this.registeredProviders.push(token);
      }
    }
  }

  private isAppToken(token: Token): boolean {
    return APP_TOKENS.has(token);
  }

  private buildExportSet(
    exports: Array<Type | InjectionToken>,
    providers: Array<Type | ProviderOptions>,
    importedProviders: Set<Token>,
  ): Set<Token> {
    const exportSet = new Set<Token>();
    const providerTokens = new Set<Token>();
    for (const p of providers) {
      const token = tokenOfProvider(p);
      if (token !== undefined) providerTokens.add(token);
    }

    for (const exported of exports) {
      const isLocalProvider = providerTokens.has(exported as Token);
      const isImportedProvider = importedProviders.has(exported as Token);

      if (!isLocalProvider && !isImportedProvider) {
        const name = (exported as { name?: string }).name ?? String(exported);
        console.warn(
          `Warning: Exporting '${name}' which is neither a local provider nor imported from another module.`,
        );
      }

      exportSet.add(exported as Token);
    }

    return exportSet;
  }

  getControllers(): Type[] {
    return [...this.collectedControllers];
  }

  getRegisteredProviders(): Token[] {
    return [...this.registeredProviders];
  }

  getAppProviderTokens(token: Token): Token[] {
    return [...(this.appProviderTokens.get(token) ?? [])];
  }

  getConsumerMiddlewareDefinitions(): MiddlewareRouteDefinition[] {
    return [...this.consumerMiddlewareDefinitions];
  }

  async resolveAllInstances(): Promise<unknown[]> {
    const instanceSet = new Set<unknown>();

    for (const token of this.registeredProviders) {
      try {
        if (this.container.getProviderScope(token) === Scope.REQUEST) {
          continue;
        }
        const instance = await this.container.resolveAsync(token);
        instanceSet.add(instance);
      } catch (err) {
        // Module visibility errors must always propagate — they indicate a
        // wiring bug the user explicitly asked to enforce by enabling strict.
        if (err instanceof ModuleVisibilityError) throw err;
        this.routeError(err, `resolve provider`);
      }
    }

    for (const controller of this.collectedControllers) {
      try {
        if (this.container.getProviderScope(controller) === Scope.REQUEST) {
          continue;
        }
        const instance = await this.container.resolveAsync(controller);
        instanceSet.add(instance);
      } catch (err) {
        if (err instanceof ModuleVisibilityError) throw err;
        this.routeError(err, `resolve controller ${controller.name}`);
      }
    }

    return [...instanceSet];
  }

  private routeError(err: unknown, context: string): void {
    const mode = this.container.getDiagnostics();
    if (mode === "silent") return;
    if (mode === "throw") {
      throw err instanceof Error ? err : new Error(String(err));
    }
    // 'log'
    console.warn(`[vela] ${context} failed:`, err);
  }
}
