import type { StorageDriver } from '../storage.types';
import type { Middleware, RawPreservingMiddleware } from './wrap';

/**
 * Compose middlewares over a base driver. Listed innermost → outermost:
 * `compose(base, a, b, c)` yields `c(b(a(base)))`, so on any call `c` runs
 * first (outermost) and `base` last. The same wrapper handles read and write,
 * so the reverse order on download comes for free.
 *
 * There is deliberately NO default preset — each middleware is opt-in, so you
 * never accidentally ship, e.g., compress-then-encrypt (a CRIME/BREACH vector).
 */
export function compose<Raw>(
  base: StorageDriver<Raw>,
  ...middlewares: RawPreservingMiddleware[]
): StorageDriver<Raw>;
export function compose(base: StorageDriver, ...middlewares: Middleware[]): StorageDriver;
export function compose(base: StorageDriver, ...middlewares: Middleware[]): StorageDriver {
  return middlewares.reduce((driver, wrap) => wrap(driver), base);
}
