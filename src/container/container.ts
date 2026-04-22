import { Scope } from '../constants';
import {
  getConstructorDependencies,
  getInjectMetadata,
  getScope,
  isInjectable,
} from './decorators';
import type { ProviderOptions, ProviderRegistration, Token, Type } from './types';
import { ForwardRef, InjectionToken } from './types';

const IMPORT_TYPE_HINT =
  'Did you use `import type { X }`? TypeScript strips type-only imports at ' +
  'runtime and `design:paramtypes` emits `Object`/`undefined` for their ' +
  'positions. Use a runtime `import { X }` for DI tokens.';

export class Container {
  private providers = new Map<Token, ProviderRegistration>();
  private resolutionStack = new Set<Token>();
  private parent: Container | null = null;
  private requestInstances = new Map<Token, unknown>();

  register<T>(provider: Type<T> | ProviderOptions<T>): this {
    if (typeof provider === 'function') {
      this.registerClass(provider);
    } else {
      this.registerOptions(provider);
    }
    return this;
  }

  private registerClass<T>(target: Type<T>): void {
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
  }

  private registerOptions<T>(options: ProviderOptions<T>): void {
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
      registration.useClass = token as Type<T>;
    }

    this.providers.set(token, registration);
  }

  resolve<T>(token: Token<T>): T {
    const registration = this.providers.get(token);

    if (!registration) {
      // `Object`/undefined at a token position is the fingerprint of a
      // type-only import that TypeScript stripped — emit the hint BEFORE
      // auto-registering Object as a provider (which would silently "succeed").
      if (token === (Object as unknown as Token<T>) || token == null) {
        throw new Error(
          `No provider found for token: ${this.tokenToString(token)}. ` +
            IMPORT_TYPE_HINT,
        );
      }

      if (typeof token === 'function') {
        this.register(token);
        return this.resolve(token);
      }

      if (token instanceof InjectionToken && token.options?.factory) {
        this.register({
          provide: token,
          useFactory: token.options.factory,
        });
        return this.resolve(token);
      }

      throw new Error(`No provider found for token: ${this.tokenToString(token)}`);
    }

    return this.resolveRegistration(registration) as T;
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
    const child = new Container();
    child.parent = this;
    child.providers = this.providers; // share provider registrations
    return child;
  }

  createDetached(): Container {
    const child = new Container();
    child.providers = new Map(this.providers); // copy, not share
    return child;
  }

  clear(): void {
    this.providers.clear();
    this.resolutionStack.clear();
    this.requestInstances.clear();
  }

  private resolveRegistration<T>(registration: ProviderRegistration<T>): T {
    if (registration.useValue !== undefined) {
      return registration.useValue;
    }

    if (registration.useExisting) {
      return this.resolve(registration.useExisting);
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

  private resolveClass<T>(target: Type<T>): T {
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
        return this.createLazyProxy(token);
      }

      return this.resolve(token);
    });

    return new target(...dependencies);
  }

  private resolveFactory<T>(registration: ProviderRegistration<T>): T {
    if (!registration.useFactory) {
      throw new Error('Factory function is missing');
    }

    const dependencies = (registration.inject || []).map((token) => {
      const resolved = token instanceof ForwardRef ? token.factory() : token;
      return this.resolve(resolved as Token);
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

  async resolveAsync<T>(token: Token<T>): Promise<T> {
    const registration = this.providers.get(token);

    if (!registration) {
      if (typeof token === 'function') {
        this.register(token);
        return this.resolveAsync(token);
      }
      throw new Error(`No provider found for token: ${this.tokenToString(token)}`);
    }

    if (registration.useFactory) {
      if (registration.scope === Scope.SINGLETON && registration.instance !== undefined) {
        return registration.instance as T;
      }

      const dependencies = await Promise.all(
        (registration.inject || []).map((t) => this.resolveAsync(t)),
      );

      const instance = await registration.useFactory(...dependencies);

      if (registration.scope === Scope.SINGLETON) {
        registration.instance = instance as T;
      }

      return instance as T;
    }

    return this.resolve(token);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createLazyProxy<T>(token: Token<T>): T {
    const container = this;
    return new Proxy({} as any, {
      get(_target, prop) {
        const instance = container.resolve(token);
        const value = (instance as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
      },
      set(_target, prop, value) {
        const instance = container.resolve(token);
        (instance as Record<string | symbol, unknown>)[prop] = value;
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
