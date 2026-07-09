import type { Context } from 'hono';
import type { Container } from '../container/container';

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
  const container = c.get('container') as Container | undefined;
  if (!container) {
    throw new Error(
      'getRequestContainer(c) can only be called inside a Vela-managed request — ' +
        'the request child container is seeded by RouteManager when the request enters the pipeline.',
    );
  }
  return container;
}
