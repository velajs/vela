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
import { ForwardRef, InjectionToken, ModuleVisibilityError } from './types';

const IMPORT_TYPE_HINT =
  'Did you use `import type { X }`? TypeScript strips type-only imports at ' +
  'runtime and `design:paramtypes` emits `Object`/`undefined` for their ' +
  'positions. Use a runtime `import { X }` for DI tokens.';

export class Container {
  private providers = new Map<Token, ProviderRegistration>();
  private resolutionStack = new Set<Token>();
  private requestInstances = new Map<Token, unknown>();
  private scopes = new Map<string, ModuleScope>();
  private globals = new Set<Token>();
  private providerOrigin = new Map<Token, string>();
  private diagnostics: Diagnostics;

  constructor(options: ContainerOptions = {}) {
    this.diagnostics = options.diagnostics ?? 'log';
  }

  register<T>(
    provider: Type<T> | ProviderOptions<T>,
    declaringModuleId?: string,
  ): this {
    if (typeof provider === 'function') {
      this.registerClass(provider, declaringModuleId);
    } else {
      this.registerOptions(provider, declaringModuleId);
    }
    return this;
  }

  private registerClass<T>(target: Type<T>, declaringModuleId?: string): void {
    if (!isInjectable(target)) {
      console.warn(
        `Warning: ${target.name} is not decorated with @Injectable(). ` +
          `It will be registered but dependency resolution may not work correctly.`,
      );
    }

    const scope = getScope(target);
    this.providers.set(target, {
      provide: target,
      scope,
      useClass: target,
    });
    this.recordOrigin(target, declaringModuleId);
  }

  private registerOptions<T>(
    options: ProviderOptions<T>,
    declaringModuleId?: string,
  ): void {
    const token = options.provide;
    if (!token) {
      throw new Error('Provider registration requires a token');
    }

    const registration: ProviderRegistration<T> = {
      provide: token,
      scope: options.scope ?? Scope.SINGLETON,
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

    this.providers.set(token, registration);
    this.recordOrigin(token, declaringModuleId);

    // For aliases like `{ provide: Foo, useClass: Bar }`, also record Bar's
    // origin so `resolveClass(Bar)` resolves Bar's deps from the alias's
    // declaring module. Idempotent if Bar === Foo.
    if (options.useClass !== undefined) {
      this.recordOrigin(options.useClass, declaringModuleId);
    }
  }

  private recordOrigin(token: Token, moduleId: string | undefined): void {
    if (moduleId !== undefined) {
      this.providerOrigin.set(token, moduleId);
    } else {
      // Sandbox containers (createDetached) re-register tokens with no
      // moduleId; clearing keeps the token "module-less" so it's only
      // resolvable when the requester is also undefined.
      this.providerOrigin.delete(token);
    }
  }

  registerScope(scope: ModuleScope): void {
    this.scopes.set(scope.moduleId, scope);
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

  getDiagnostics(): Diagnostics {
    return this.diagnostics;
  }

  resolve<T>(token: Token<T>, requestingModuleId?: string): T {
    if (requestingModuleId !== undefined) {
      this.assertVisible(requestingModuleId, token);
    }

    const registration = this.providers.get(token);

    if (!registration) {
      // `Object`/undefined at a token position is the fingerprint of a
      // type-only import that TypeScript stripped — emit the hint before
      // attempting any other recovery.
      if (token === (Object as unknown as Token<T>) || token == null) {
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
        this.register({
          provide: token,
          useFactory: token.options.factory,
        });
        return this.resolve(token, requestingModuleId);
      }

      throw new Error(`No provider found for token: ${this.tokenToString(token)}`);
    }

    return this.resolveRegistration(registration, requestingModuleId) as T;
  }

  resolveAll<T>(token: Token<T>, requestingModuleId?: string): T[] {
    if (!this.has(token)) return [];
    return [this.resolve(token, requestingModuleId)];
  }

  has(token: Token): boolean {
    return this.providers.has(token);
  }

  getProviderScope(token: Token): Scope | undefined {
    return this.providers.get(token)?.scope;
  }

  getTokens(): Token[] {
    return Array.from(this.providers.keys());
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
    child.scopes = this.scopes;
    child.globals = this.globals;
    child.providerOrigin = this.providerOrigin;
    return child;
  }

  createDetached(): Container {
    const child = new Container({ diagnostics: this.diagnostics });
    // Copy mutable per-resolution state; share static module-graph metadata
    // so sandbox resolutions can still see exported providers.
    child.providers = new Map(this.providers);
    child.providerOrigin = new Map(this.providerOrigin);
    child.scopes = this.scopes;
    child.globals = this.globals;
    return child;
  }

  clear(): void {
    this.providers.clear();
    this.resolutionStack.clear();
    this.requestInstances.clear();
    this.scopes.clear();
    this.globals.clear();
    this.providerOrigin.clear();
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
      const cached = this.requestInstances.get(registration.provide);
      if (cached !== undefined) {
        return cached as T;
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
        // surface to track that, so factory inject deps resolve without a
        // requester — same escape-hatch shape as ModuleRef.
        instance = this.resolveFactory(registration);
      } else if (registration.useClass) {
        instance = this.resolveClass(registration.useClass);
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

  private resolveClass<T>(target: Type<T>, callerModuleId?: string): T {
    // The class's dependencies resolve from ITS module's POV, not the caller's.
    const ownerModuleId = this.providerOrigin.get(target) ?? callerModuleId;
    const paramTypes = getConstructorDependencies(target);
    const injectMetadata = getInjectMetadata(target);
    const injectMap = new Map(injectMetadata.map((m) => [m.index, m]));

    const dependencies = paramTypes.map((paramType, index) => {
      const meta = injectMap.get(index);
      const rawToken = meta?.token;
      const isForwardRef = rawToken instanceof ForwardRef;
      const token: Token | undefined = isForwardRef
        ? rawToken.factory()
        : (rawToken as Token | undefined) ?? (paramType as Token);

      if (!token || token === Object) {
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

  private resolveFactory<T>(
    registration: ProviderRegistration<T>,
    requestingModuleId?: string,
  ): T {
    if (!registration.useFactory) {
      throw new Error('Factory function is missing');
    }

    const dependencies = (registration.inject || []).map((token) => {
      const resolved = token instanceof ForwardRef ? token.factory() : token;
      return this.resolve(resolved as Token, requestingModuleId);
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
    if (requestingModuleId !== undefined) {
      this.assertVisible(requestingModuleId, token);
    }

    const registration = this.providers.get(token);

    if (!registration) {
      if (typeof token === 'function') {
        throw new Error(
          `No provider found for token: ${this.tokenToString(token)}. ` +
            `Declare it in a module's providers.`,
        );
      }
      if (token instanceof InjectionToken && token.options?.factory) {
        // Self-providing token — register on demand from its declared factory.
        this.register({ provide: token, useFactory: token.options.factory });
        return this.resolveAsync(token, requestingModuleId);
      }
      throw new Error(`No provider found for token: ${this.tokenToString(token)}`);
    }

    if (registration.useFactory) {
      if (registration.scope === Scope.SINGLETON && registration.instance !== undefined) {
        return registration.instance as T;
      }

      // Factory inject deps resolve without a requester (escape hatch — see
      // resolveRegistration's useFactory branch).
      const dependencies = await Promise.all(
        (registration.inject || []).map((t) => {
          const resolved = t instanceof ForwardRef ? t.factory() : t;
          return this.resolveAsync(resolved as Token);
        }),
      );

      const instance = await registration.useFactory(...dependencies);

      if (registration.scope === Scope.SINGLETON) {
        registration.instance = instance as T;
      }

      return instance as T;
    }

    return this.resolve(token, requestingModuleId);
  }

  private createLazyProxy(token: Token, requestingModuleId?: string): object {
    const container = this;
    const target: Record<PropertyKey, unknown> = Object.create(null);
    return new Proxy(target, {
      get(_target, prop) {
        const instance = container.resolve(token, requestingModuleId);
        const value = (instance as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
      },
      set(_target, prop, value) {
        const instance = container.resolve(token, requestingModuleId);
        (instance as Record<string | symbol, unknown>)[prop] = value;
        return true;
      },
    });
  }

  private assertVisible(moduleId: string, token: Token): void {
    if (this.globals.has(token)) return;

    // InjectionTokens with a default factory are self-providing singletons —
    // visible from any module without requiring explicit declaration.
    if (token instanceof InjectionToken && token.options?.factory) return;

    const scope = this.scopes.get(moduleId);
    if (!scope) {
      // No scope registered for this moduleId — typically synthetic /
      // framework-internal callers. Allow rather than break primitives.
      return;
    }

    if (scope.localProviders.has(token)) return;
    if (this.isExportedFromImports(scope, token)) return;

    throw new ModuleVisibilityError(moduleId, token);
  }

  private isExportedFromImports(scope: ModuleScope, token: Token): boolean {
    for (const importedId of scope.importedModules) {
      const imported = this.scopes.get(importedId);
      if (imported?.exportedTokens.has(token)) return true;
    }
    return false;
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
