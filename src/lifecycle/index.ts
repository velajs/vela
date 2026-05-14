export interface OnModuleInit {
  onModuleInit(): void | Promise<void>;
}

export interface OnApplicationBootstrap {
  onApplicationBootstrap(): void | Promise<void>;
}

/**
 * Fires exactly once, on the first incoming HTTP request, AFTER user-supplied
 * middleware (so binding initializers like `@velajs/cloudflare`'s env capture
 * run first) and BEFORE route handlers. The hook bridges module-load and
 * request-time semantics — use it for state that depends on values only
 * available at request time (Cloudflare bindings, Deno Deploy env, etc.).
 *
 * Concurrency: vela memoizes the call. Concurrent first requests all await
 * the same promise; the hook runs exactly once.
 *
 * Non-HTTP consumers (CLI, tests) can trigger it manually via
 * `app.callOnFirstRequest()`.
 *
 * Edge-safe: the hook itself is just `() => void | Promise<void>`. The
 * runtime contract is async/Promise — no Node-only APIs are involved.
 */
export interface OnFirstRequest {
  onFirstRequest(): void | Promise<void>;
}

export interface OnModuleDestroy {
  onModuleDestroy(): void | Promise<void>;
}

export interface OnApplicationShutdown {
  onApplicationShutdown(signal?: string): void | Promise<void>;
}

export interface BeforeApplicationShutdown {
  beforeApplicationShutdown(signal?: string): void | Promise<void>;
}

export function hasOnModuleInit(instance: unknown): instance is OnModuleInit {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnModuleInit).onModuleInit === 'function'
  );
}

export function hasOnApplicationBootstrap(instance: unknown): instance is OnApplicationBootstrap {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnApplicationBootstrap).onApplicationBootstrap === 'function'
  );
}

export function hasOnFirstRequest(instance: unknown): instance is OnFirstRequest {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnFirstRequest).onFirstRequest === 'function'
  );
}

export function hasOnModuleDestroy(instance: unknown): instance is OnModuleDestroy {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnModuleDestroy).onModuleDestroy === 'function'
  );
}

export function hasBeforeApplicationShutdown(
  instance: unknown,
): instance is BeforeApplicationShutdown {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as BeforeApplicationShutdown).beforeApplicationShutdown === 'function'
  );
}

export function hasOnApplicationShutdown(instance: unknown): instance is OnApplicationShutdown {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnApplicationShutdown).onApplicationShutdown === 'function'
  );
}
