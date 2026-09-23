import type {
  VelaContext as Context,
  VelaMiddlewareHandler as MiddlewareHandler,
} from '../http/hono.types';
import type { VelaApplication } from '../application';
import type { Container } from '../container/container';
import type { DiscoveryService } from '../discovery/discovery.service';
import type { InvocationTransport } from '../dispatch/types';
import type { RouteManager } from '../http/route.manager';
import type { BootstrapOptions } from './bootstrap';

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
 *   adapters: [cloudflareAdapter({ env })],
 * });
 * ```
 *
 * (`createCloudflareApp` and `createCloudflareWorker` register that adapter for you.)
 *
 * - `requestMiddleware` is prepended to the global middleware chain (runs
 *   before consumer middleware — e.g. capture `c.env` for binding services).
 * - `configureContainer` runs before module loading and provider construction,
 *   so platform services are available to module factories and lifecycle hooks.
 *   A runtime seeds the application's `ENV` (bindings, variables, secrets) here.
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
  configureContainer?(container: Container): void | Promise<void>;
  /** Platform-attested client address resolver used by @Ip() and default throttling. */
  getClientIp?: (c: Context) => string | null;
  requestMiddleware?: MiddlewareHandler[];
  onBootstrap?(ctx: AdapterContext): void | Promise<void>;
  onRoutesBuilt?(ctx: AdapterContext): void | Promise<void>;
  invocationTransport?(ctx: AdapterContext): InvocationTransport | undefined;
}

/**
 * Fold runtime adapters into bootstrap options: one trusted client-IP resolver,
 * adapter request middleware ahead of the application's, and every adapter's
 * `configureContainer` before the caller's. Shared by `VelaFactory.create` and
 * `@velajs/testing`, so test applications bind adapters like production.
 */
export function applyRuntimeAdapters(
  options: BootstrapOptions,
  adapters: readonly RuntimeAdapter[],
): BootstrapOptions {
  const composed: BootstrapOptions = { ...options };
  const adapterIpResolvers = adapters.filter(
    (adapter): adapter is RuntimeAdapter & Required<Pick<RuntimeAdapter, 'getClientIp'>> =>
      adapter.getClientIp !== undefined,
  );
  if (adapterIpResolvers.length > 1) {
    throw new Error(
      `Multiple runtime adapters provide getClientIp (${adapterIpResolvers.map((a) => a.name).join(', ')}); configure exactly one trust boundary`,
    );
  }
  if (composed.getClientIp && adapterIpResolvers.length === 1) {
    throw new Error(
      'Configure getClientIp either explicitly or through a runtime adapter, not both',
    );
  }
  if (adapterIpResolvers[0]) composed.getClientIp = adapterIpResolvers[0].getClientIp;

  const adapterMiddleware = adapters.flatMap((a) => a.requestMiddleware ?? []);
  if (adapterMiddleware.length > 0) {
    composed.middleware = [...adapterMiddleware, ...(composed.middleware ?? [])];
  }

  const configureContainer = options.configureContainer;
  composed.configureContainer = async (container) => {
    for (const adapter of adapters) {
      await adapter.configureContainer?.(container);
    }
    await configureContainer?.(container);
  };
  return composed;
}
