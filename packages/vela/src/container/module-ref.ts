import type { Context } from 'hono';
import { Scope } from '../constants';
import { assertExecutionScopeActive } from '../entrypoint/execution-scope';
import { findRequestContainer } from '../http/request-container';
import type { ExecutionContext } from '../pipeline/types';
import { Container } from './container';
import type { InferToken, Token, Type } from './types';
import { describeToken } from './types';

export interface ModuleRefLookupOptions {
  /**
   * `true` (default) resolves only what the host module can inject: its own
   * providers, its imports' exports and global tokens. `false` looks the token
   * up across the whole application.
   */
  readonly strict?: boolean;
}

/**
 * Identifies the execution scope `ModuleRef.resolve` resolves in: a guard's or
 * interceptor's `ExecutionContext`, the Hono `Context` of a Vela-managed
 * request, or an execution-scope container (`getRequestContainer(c)`,
 * `context.getContainer()`, the `runInEntrypointScope` callback argument).
 */
export type ModuleRefContext = ExecutionContext | Context | Container;

/**
 * Container access from the point of view of the module that injected it.
 * The container builds one instance per module and owner: singletons receive
 * one owned by the application root, request-scoped consumers one bound to
 * their own request (closed with it). Inject it; do not construct it.
 */
export class ModuleRef {
  readonly #container: Container;
  readonly #moduleId: string;

  constructor(container: Container, moduleId: string) {
    this.#container = container;
    this.#moduleId = moduleId;
  }

  /**
   * Return a singleton (or value) provider. Request-scoped and transient
   * providers have no single instance to return; use `resolve()` for them.
   */
  get<K extends Token>(token: K, options: ModuleRefLookupOptions = {}): InferToken<K> {
    assertExecutionScopeActive(this.#container);
    const moduleId = this.#lookupModuleId(options);
    const scope = this.#container.getResolvedScope(token, moduleId);
    if (scope === Scope.REQUEST || scope === Scope.TRANSIENT) {
      const name = describeToken(token);
      throw new Error(
        `ModuleRef.get(${name}) returns singletons only, but ${name} is ${scope === Scope.REQUEST ? 'request-scoped' : 'transient'}. ` +
          `Use \`await moduleRef.resolve(${name}, context)\` to resolve it in the current request or invocation.`,
      );
    }
    return this.#container.resolve(token, moduleId);
  }

  /**
   * Resolve any provider, awaiting async factories. Request-scoped providers
   * resolve in the execution scope identified by `context`; without one they
   * resolve where this reference is owned, which the root refuses for them.
   * Transient providers are constructed anew on each call.
   */
  async resolve<K extends Token>(
    token: K,
    context?: ModuleRefContext,
    options: ModuleRefLookupOptions = {},
  ): Promise<InferToken<K>> {
    const container = context === undefined ? this.#container : this.#scopeOf(context);
    assertExecutionScopeActive(container);
    return container.resolveAsync(token, this.#lookupModuleId(options));
  }

  /**
   * Construct a class that is not registered as a provider, injecting what
   * the host module can see. Each call returns a new instance the caller owns.
   */
  async create<T>(type: Type<T>): Promise<T> {
    assertExecutionScopeActive(this.#container);
    return this.#container.construct(type, this.#moduleId);
  }

  #lookupModuleId(options: ModuleRefLookupOptions): string | undefined {
    return options.strict === false ? undefined : this.#moduleId;
  }

  // Only an existing scope is accepted: a fresh child would own request
  // disposables that nothing ever finishes.
  #scopeOf(context: ModuleRefContext): Container {
    const container =
      context instanceof Container
        ? context
        : 'getContainer' in context
          ? context.getContainer()
          : findRequestContainer(context);
    if (!container) {
      throw new Error(
        'ModuleRef.resolve(token, context) needs an ExecutionContext, the Hono Context of a ' +
          'Vela-managed request, or an execution-scope container (getRequestContainer(c), ' +
          'context.getContainer(), runInEntrypointScope()). It never creates a request scope.',
      );
    }
    if (!container.sharesRootWith(this.#container)) {
      throw new Error('ModuleRef.resolve(token, context) received a scope of another application.');
    }
    return container;
  }
}
