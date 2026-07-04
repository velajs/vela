import type { MiddlewareHandler } from 'hono';
import type { VelaApplication } from '../application';
import type { Container } from '../container/container';
import type { DiscoveryService } from '../discovery/discovery.service';
import type { RouteManager } from '../http/route.manager';

/** The framework's resolved world, handed to adapter hooks. */
export interface AdapterContext {
  app: VelaApplication;
  container: Container;
  routeManager: RouteManager;
  discovery: DiscoveryService;
}

/**
 * The contract a runtime binding implements to plug a platform into a Vela
 * app — what `@velajs/cloudflare` (bindings + Durable Object WebSocket) and
 * the Node/Bun WebSocket transport do, made first-class:
 *
 * ```ts
 * const app = await VelaFactory.create(AppModule, {
 *   adapters: [cloudflareAdapter({ bindings })],
 * });
 * ```
 *
 * - `requestMiddleware` is prepended to the global middleware chain (runs
 *   before consumer middleware — e.g. capture `c.env` for binding services).
 * - `onBootstrap` runs after DI + lifecycle hooks, with `app.entrypoints`
 *   available, BEFORE routes are built — register platform services here.
 * - `onRoutesBuilt` runs after the Hono app exists — mount platform routes
 *   (WebSocket upgrades, health endpoints) here via `ctx.app.getHonoApp()`.
 */
export interface RuntimeAdapter {
  name: string;
  requestMiddleware?: MiddlewareHandler[];
  onBootstrap?(ctx: AdapterContext): void | Promise<void>;
  onRoutesBuilt?(ctx: AdapterContext): void | Promise<void>;
}
