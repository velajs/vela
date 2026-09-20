import type { Container } from '../container/container';

/**
 * Run one unit of non-HTTP work (a queue batch, a scheduled tick, an RPC
 * call) inside a fresh request-scoped child container — the non-HTTP
 * equivalent of the per-request child the HTTP pipeline creates:
 *
 * ```ts
 * await runInEntrypointScope(app.getContainer(), async (scope) => {
 *   const consumer = scope.resolve(ep.token);
 *   await consumer.process(batch);
 * });
 * ```
 *
 * Request-scoped providers (and singletons bubbled to request scope) resolve
 * per invocation instead of leaking one boot-time instance across every
 * dispatch; the child's request-scoped disposables are disposed (LIFO) when
 * `fn` settles — success or failure. `REQUEST_CONTEXT` is deliberately NOT
 * seeded: it is an HTTP primitive, and resolving it here keeps throwing its
 * explicit misuse error.
 */
export async function runInEntrypointScope<T>(
  container: Container,
  fn: (scope: Container) => T | Promise<T>,
): Promise<T> {
  const scope = container.createChild();
  try {
    return await fn(scope);
  } finally {
    if (scope.hasDisposables()) {
      await scope.dispose();
    }
  }
}
