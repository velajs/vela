import { Scope } from '../constants';
import type { Container } from '../container/container';
import { ForwardRef, InjectionToken } from '../container/types';
import type { ProviderOptions, Token, Type } from '../container/types';
import { MiddlewareBuilder } from '../http/middleware-consumer';
import type { MiddlewareRouteDefinition } from '../http/middleware-consumer';
import type { RouteManager } from '../http/route.manager';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_MIDDLEWARE, APP_PIPE } from '../pipeline/tokens';
import { MetadataRegistry } from '../registry/metadata.registry';
import { getModuleMetadata, isModule } from './decorators';
import type { ModuleImport } from './types';

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
    typeof value === 'object' &&
    value !== null &&
    'module' in value &&
    typeof (value as DynamicModule).module === 'function'
  );
}

export class ModuleLoader {
  private processedModules = new Set<Type>();
  private processingStack = new Set<Type>();
  private collectedControllers: Type[] = [];
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

  private processModule(moduleClassOrDynamic: Type | DynamicModule): Set<Token> {
    // Handle dynamic modules ({ module, imports, controllers, providers })
    let moduleClass: Type;
    let extraImports: ModuleImport[] = [];
    let extraControllers: Type[] = [];
    let extraProviders: Array<Type | ProviderOptions> = [];

    if (isDynamicModule(moduleClassOrDynamic)) {
      moduleClass = moduleClassOrDynamic.module;
      extraImports = moduleClassOrDynamic.imports ?? [];
      extraControllers = moduleClassOrDynamic.controllers ?? [];
      extraProviders = moduleClassOrDynamic.providers ?? [];
    } else {
      moduleClass = moduleClassOrDynamic;
    }

    if (this.processedModules.has(moduleClass)) {
      // Even if already processed, still collect extra controllers from dynamic module
      for (const controller of extraControllers) {
        if (!this.collectedControllers.includes(controller)) {
          this.collectedControllers.push(controller);
        }
      }
      return this.moduleExportsCache.get(moduleClass) ?? new Set();
    }

    if (this.processingStack.has(moduleClass)) {
      const chain = [...this.processingStack, moduleClass].map((m) => m.name).join(' -> ');
      throw new Error(`Circular module dependency detected: ${chain}`);
    }

    if (!isModule(moduleClass)) {
      throw new Error(`${moduleClass.name} is not a module. Add @Module() decorator to the class.`);
    }

    const metadata = getModuleMetadata(moduleClass);
    if (!metadata) {
      throw new Error(`Failed to get module metadata for ${moduleClass.name}`);
    }

    this.processingStack.add(moduleClass);

    try {
      const importedProviders = new Set<Token>(this.globalExports);

      for (const entry of [...metadata.imports, ...extraImports]) {
        // Unwrap forwardRef(() => Module) — resolves lazy circular references
        const isForwardRef = entry instanceof ForwardRef;
        const importedModule = isForwardRef
          ? (entry.factory() as Type | DynamicModule)
          : entry as Type | DynamicModule;

        const importedModuleClass = isDynamicModule(importedModule)
          ? importedModule.module
          : importedModule as Type;

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

      // Register metadata providers + dynamic module extra providers
      const allProviders = [...metadata.providers, ...extraProviders];
      for (const provider of allProviders) {
        this.registerProvider(provider);
      }

      // Collect metadata controllers + dynamic module extra controllers
      const allControllers = [...metadata.controllers, ...extraControllers];
      for (const controller of allControllers) {
        if (!this.collectedControllers.includes(controller)) {
          this.collectedControllers.push(controller);
        }
      }

      // Propagate module-level Use* decorators (@UseGuards, @UseInterceptors, etc.) to each controller
      for (const controller of allControllers) {
        MetadataRegistry.propagateControllerComponents(moduleClass, controller);
      }

      this.processedModules.add(moduleClass);

      const exports = this.buildExportSet(metadata.exports, allProviders, importedProviders);
      this.moduleExportsCache.set(moduleClass, exports);

      const isGlobal = metadata.isGlobal || (isDynamicModule(moduleClassOrDynamic) && moduleClassOrDynamic.global === true);
      if (isGlobal) {
        for (const token of exports) {
          this.globalExports.add(token);
        }
      }

      // Call configure() if the module implements NestModule
      if (typeof (moduleClass as { prototype?: { configure?: unknown } }).prototype?.configure === 'function') {
        try {
          const instance = new moduleClass() as { configure: (c: MiddlewareBuilder) => void };
          const builder = new MiddlewareBuilder();
          instance.configure(builder);
          this.consumerMiddlewareDefinitions.push(...builder.getDefinitions());
        } catch {
          // Module has constructor dependencies — configure() skipped
        }
      }

      return exports;
    } finally {
      this.processingStack.delete(moduleClass);
    }
  }

  private registerProvider(provider: Type | ProviderOptions): void {
    if (typeof provider === 'function') {
      if (!this.container.has(provider)) {
        this.container.register(provider);
        this.registeredProviders.push(provider);
      }
    } else {
      const token = provider.token;
      if (!token) {
        this.container.register(provider);
        return;
      }

      if (this.isAppToken(token)) {
        const syntheticToken = new InjectionToken(
          `${token.toString()}:${this.appProviderCounter++}`,
        );
        this.container.register({ ...provider, token: syntheticToken });
        this.registeredProviders.push(syntheticToken);
        this.appProviderTokens.get(token)!.push(syntheticToken);
        return;
      }

      if (!this.container.has(token)) {
        this.container.register(provider);
        this.registeredProviders.push(token);
      }
    }
  }

  private isAppToken(token: Token): boolean {
    return (
      token === APP_GUARD ||
      token === APP_PIPE ||
      token === APP_INTERCEPTOR ||
      token === APP_FILTER ||
      token === APP_MIDDLEWARE
    );
  }

  private buildExportSet(
    exports: Array<Type | InjectionToken>,
    providers: Array<Type | ProviderOptions>,
    importedProviders: Set<Token>,
  ): Set<Token> {
    const exportSet = new Set<Token>();

    for (const exported of exports) {
      const isLocalProvider = providers.some((p) => {
        if (typeof p === 'function') {
          return p === exported;
        }
        return p.token === exported;
      });

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
    const instances: unknown[] = [];

    for (const token of this.registeredProviders) {
      try {
        if (this.container.getProviderScope(token) === Scope.REQUEST) {
          continue;
        }
        const instance = await this.container.resolveAsync(token);
        instances.push(instance);
      } catch {
        // Skip unresolvable tokens
      }
    }

    for (const controller of this.collectedControllers) {
      try {
        if (this.container.getProviderScope(controller) === Scope.REQUEST) {
          continue;
        }
        const instance = await this.container.resolveAsync(controller);
        if (!instances.includes(instance)) {
          instances.push(instance);
        }
      } catch {
        // Skip unresolvable controllers
      }
    }

    return instances;
  }
}
