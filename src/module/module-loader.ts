import type { Container } from '../container/container';
import type { InjectionToken, ProviderOptions, Token, Type } from '../container/types';
import type { RouteManager } from '../http/route.manager';
import { getModuleMetadata, isModule } from './decorators';

interface DynamicModule {
  module: Type;
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  exports?: Array<Type | InjectionToken>;
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
    // Handle dynamic modules ({ module, controllers, providers })
    let moduleClass: Type;
    let extraControllers: Type[] = [];
    let extraProviders: Array<Type | ProviderOptions> = [];

    if (isDynamicModule(moduleClassOrDynamic)) {
      moduleClass = moduleClassOrDynamic.module;
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
      const importedProviders = new Set<Token>();

      for (const importedModule of metadata.imports) {
        const exportedTokens = this.processModule(importedModule as Type | DynamicModule);
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

      this.processedModules.add(moduleClass);

      const exports = this.buildExportSet(metadata.exports, allProviders, importedProviders);
      this.moduleExportsCache.set(moduleClass, exports);

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
      if (token && !this.container.has(token)) {
        this.container.register(provider);
        this.registeredProviders.push(token);
      } else if (!token) {
        this.container.register(provider);
      }
    }
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

  resolveAllInstances(): unknown[] {
    const instances: unknown[] = [];

    for (const token of this.registeredProviders) {
      try {
        const instance = this.container.resolve(token);
        instances.push(instance);
      } catch {
        // Skip unresolvable tokens
      }
    }

    for (const controller of this.collectedControllers) {
      try {
        const instance = this.container.resolve(controller);
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
