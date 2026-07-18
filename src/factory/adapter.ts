import type { MiddlewareHandler } from 'hono';
import type { Context } from 'hono';
import type { VelaApplication } from '../application';
import type { Container } from '../container/container';
import type { DiscoveryService } from '../discovery/discovery.service';
import type { InvocationTransport } from '../dispatch/types';
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
 * - `invocationTransport` supplies the transport `InternalDispatcher` (`ctx.run`)
 *   uses to re-enter the app. In-isolate adapters return `undefined` so core's
 *   default `app.fetch` short-circuit is used; a separate-binding adapter (e.g.
 *   a Cloudflare Workflow entrypoint) returns an HTTP transport over its service
 *   binding / origin so re-entry crosses back to where the routes live. Signing
 *   and verification are identical on both paths — only the network hop differs.
 */
export interface RuntimeAdapter {
  name: string;
  /** Platform-attested client address resolver used by @Ip() and default throttling. */
  getClientIp?: (c: Context) => string | null;
  requestMiddleware?: MiddlewareHandler[];
  onBootstrap?(ctx: AdapterContext): void | Promise<void>;
  onRoutesBuilt?(ctx: AdapterContext): void | Promise<void>;
  invocationTransport?(ctx: AdapterContext): InvocationTransport | undefined;
}
