import { defineProvider } from './types';
import { Scope } from '../constants';
import { Injectable } from './decorators';
import type { InferToken, Token, Type } from './types';
import type { Container } from './container';

@Injectable()
export class ModuleRef {
  constructor(private readonly container: Container) {}

  /**
   * Retrieve a provider instance from the DI container.
   * Returns the existing singleton (or cached value) for the token.
   */
  get<K extends Token>(token: K): InferToken<K> {
    return this.container.resolve(token);
  }

  /**
   * Resolve a provider, creating a new instance for TRANSIENT-scoped providers.
   * For SINGLETON-scoped providers this is equivalent to get().
   */
  resolve<K extends Token>(token: K): InferToken<K> {
    return this.container.resolve(token);
  }

  /**
   * Instantiate a class outside of the DI container's singleton cache.
   * Dependencies are resolved from the container. Each call returns a new instance.
   */
  create<T>(type: Type<T>): T {
    const sandbox = this.container.createDetached();
    sandbox.register(defineProvider(type, { useClass: type, scope: Scope.TRANSIENT }));
    return sandbox.resolve(type);
  }
}
