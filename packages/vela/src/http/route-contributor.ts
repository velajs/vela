import type { VelaHono as Hono } from './hono.types';
import type { Container } from '../container/container';
import type { Type } from '../container/types';
import type { OpenApiPathItem } from '../openapi/types';
import type { CanActivate } from '../pipeline/types';

/**
 * Context passed to {@link RouteContributor.buildRoutes} for each controller
 * the contributor claims. The contributor receives the framework's resolved
 * view of the world so generated routes behave identically to hand-written
 * ones: same global prefix, same global guard instances, same path joining.
 */
export interface RouteContributorContext {
  /** The claimed controller class. */
  controller: Type;
  /** Controller-level prefix as registered with `@Controller(...)`. */
  controllerPrefix: string;
  /** The metadata value (under `claimsMetaKey`) that claimed this controller. */
  meta: unknown;
  /** Application-wide path prefix (e.g. `/api`), already normalized. */
  globalPrefix: string;
  /** Global guard instances, pre-resolved from the root container. */
  globalGuards: CanActivate[];
  /** The app's root container — resolve controller/services from here. */
  container: Container;
  /** Path joiner used by the framework — handles slash normalization. */
  joinPaths: (...parts: string[]) => string;
}

/** Context for {@link RouteContributor.buildOpenApiPaths}. */
export interface RouteContributorOpenApiContext {
  controller: Type;
  meta: unknown;
  /** Application-wide path prefix (e.g. `/api`), already normalized. */
  globalPrefix: string;
  /** Controller-level prefix as registered with `@Controller(...)`. */
  controllerPrefix: string;
}

/**
 * A route generator that claims controllers by class-level metadata and
 * mounts routes for them — the public extension point behind `@Crud()` (and
 * any future metadata-driven route generator: storage HTTP surfaces, admin
 * panels, RPC bridges).
 *
 * Register once at import time (`registerRouteContributor`); the framework
 * consults contributors during `RouteManager.build` — AFTER all explicit
 * `@Get`/`@Post` routes, so generated `/:id` catch-alls never shadow custom
 * routes — and during OpenAPI document generation.
 *
 * This contract exists instead of dynamic `import()` because esbuild leaves
 * `await import(variable)` as a runtime import Cloudflare Workers cannot
 * resolve.
 */
export interface RouteContributor {
  /** Stable identifier; re-registering the same id overwrites (HMR-friendly). */
  id: string;
  /** Class-level metadata key whose presence claims a controller. */
  claimsMetaKey: string;
  buildRoutes(app: Hono, ctx: RouteContributorContext): void | Promise<void>;
  buildOpenApiPaths?(ctx: RouteContributorOpenApiContext): Record<string, OpenApiPathItem>;
}

// Contributors register at import time (package side effect), so the store is
// anchored on `globalThis` like MetadataRegistry state: a Vite HMR re-eval
// reuses the same store instead of minting an empty one.
const STORE_KEY = Symbol.for('vela:route-contributors:v1');

function store(): Map<string, RouteContributor> {
  const g = globalThis as unknown as Record<symbol, Map<string, RouteContributor> | undefined>;
  return (g[STORE_KEY] ??= new Map());
}

/** Register a contributor. Last registration per `id` wins. */
export function registerRouteContributor(contributor: RouteContributor): void {
  store().set(contributor.id, contributor);
}

/** All registered contributors (registration order). */
export function getRouteContributors(): RouteContributor[] {
  return [...store().values()];
}

/**
 * Reset all contributor registrations. Test-only.
 * @internal
 */
export function _resetRouteContributors(): void {
  store().clear();
}
