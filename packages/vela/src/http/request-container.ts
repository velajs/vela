import type { Context } from 'hono';
import type { Container } from '../container/container';
import { assertExecutionScopeActive } from '../entrypoint/execution-scope';

// Framework request state cannot collide with application-defined Hono keys.
const containers = new WeakMap<Context, Container>();

/** @internal Seeded only by the runtime and the first-party testing harness. */
export function setRequestContainer(context: Context, container: Container): void {
  containers.set(context, container);
}

/** @internal Optional lookup for lifecycle and execution-context plumbing. */
export function findRequestContainer(context: Context): Container | undefined {
  return containers.get(context);
}

/**
 * Returns the request-scoped child container for the current request.
 *
 * `@Inject(Container)` resolves the ROOT container (request children share the
 * provider map and never rebind `Container`), so module authors who need
 * request-scoped resolution from inside a handler, param-decorator factory, or
 * scoped middleware must read the child seeded by RouteManager instead. The
 * child is created before guards, pipes, params, and handlers run, so it is
 * always present on the Vela request path.
 *
 * Throws outside a Vela-managed request rather than materializing an orphan
 * child (mirrors the REQUEST_CONTEXT fail-fast).
 */
export function getRequestContainer(c: Context): Container {
  const container = findRequestContainer(c);
  if (!container) {
    throw new Error(
      'getRequestContainer(c) can only be called inside a Vela-managed request — ' +
        'the request child container is seeded by RouteManager when the request enters the pipeline.',
    );
  }
  assertExecutionScopeActive(container);
  return container;
}
