import 'reflect-metadata';
import { Scope } from '../constants';
import {
  getConstructorDependencies,
  getInjectMetadata,
  getScope,
  isInjectable,
} from './decorators';
import type { ProviderOptions, ProviderRegistration, Token, Type } from './types';
import { InjectionToken } from './types';

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
      token: target,
      scope,
      useClass: target,
    });
  }

  private registerOptions<T>(options: ProviderOptions<T>): void {
    const token = options.token;
    if (!token) {
      throw new Error('Provider registration requires a token');
    }

    const registration: ProviderRegistration<T> = {
      token,
      scope: options.scope ?? Scope.SINGLETON,
    };

    if (options.useValue !== undefined) {
      registration.useValue = options.useValue;
      registration.instance = options.useValue;
    } else if (options.useFactory) {
      registration.useFactory = options.useFactory;
      registration.inject = options.inject;
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
      if (typeof token === 'function') {
        this.register(token);
        return this.resolve(token);
      }

      if (token instanceof InjectionToken && token.options?.factory) {
        this.register({
          token,
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
      const cached = this.requestInstances.get(registration.token);
      if (cached !== undefined) {
        return cached as T;
      }
    }

    if (this.resolutionStack.has(registration.token)) {
      const chain = [...this.resolutionStack, registration.token]
        .map((t) => this.tokenToString(t))
        .join(' -> ');
      throw new Error(`Circular dependency detected: ${chain}`);
    }

    this.resolutionStack.add(registration.token);

    try {
      let instance: T;

      if (registration.useFactory) {
        instance = this.resolveFactory(registration);
      } else if (registration.useClass) {
        instance = this.resolveClass(registration.useClass);
      } else {
        throw new Error(
          `Invalid provider registration for: ${this.tokenToString(registration.token)}`,
        );
      }

      if (registration.scope === Scope.SINGLETON) {
        registration.instance = instance;
      } else if (registration.scope === Scope.REQUEST) {
        this.requestInstances.set(registration.token, instance);
      }

      return instance;
    } finally {
      this.resolutionStack.delete(registration.token);
    }
  }

  private resolveClass<T>(target: Type<T>): T {
    const paramTypes = getConstructorDependencies(target);
    const injectMetadata = getInjectMetadata(target);
    const injectMap = new Map(injectMetadata.map((m) => [m.index, m.token]));

    const dependencies = paramTypes.map((paramType, index) => {
      const token = injectMap.get(index) ?? paramType;

      if (!token || token === Object) {
        throw new Error(
          `Cannot resolve dependency at index ${index} for ${target.name}. ` +
            `Parameter type is undefined or Object. ` +
            `Use @Inject() to specify the token explicitly.`,
        );
      }

      return this.resolve(token as Token);
    });

    return new target(...dependencies);
  }

  private resolveFactory<T>(registration: ProviderRegistration<T>): T {
    if (!registration.useFactory) {
      throw new Error('Factory function is missing');
    }

    const dependencies = (registration.inject || []).map((token) => this.resolve(token));
    const result = registration.useFactory(...dependencies);

    if (result instanceof Promise) {
      throw new Error(
        `Async factory for ${this.tokenToString(registration.token)} returned a Promise. ` +
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
