import { bootstrap, VelaApplication } from '@velajs/vela';
import type { Type } from '@velajs/vela';
import { local, WsDispatcher, WsServerImpl, WS_SERVER } from '@velajs/vela/websocket';
import type { WsEntrypointMeta, WsServer } from '@velajs/vela/websocket';
import type { LiveEngine } from '@velajs/vela/live';
import { BindingRef } from '../binding-ref';
import { EnvRef } from '../env-ref';
import { CfRoomRegistry } from './cf-room-registry';
import { initDoLive } from './do-live';
import type { DoStateLike } from './do-state';
import { WsServerHolder } from './ws-server-holder';

export interface DoRuntime {
  dispatcher: WsDispatcher;
  registry: CfRoomRegistry;
  server: WsServer;
  /** Gateway paths from `app.entrypoints.ofKind('websocket')` (discovery order). */
  gatewayPaths: string[];
  /** The live-query engine (undefined when the app doesn't import LiveModule). */
  live?: LiveEngine;
  close(signal?: string): Promise<void>;
}

/**
 * Slim DI bootstrap for the Durable Object isolate: wires the container and runs
 * `OnModuleInit`/`OnApplicationBootstrap` (so `WsDispatcher` discovers gateways)
 * WITHOUT building the Hono app/routes the DO never serves. Cloudflare binding
 * refs are initialized straight from the DO's `env`, and the ctx-backed server
 * is bound before bootstrap lifecycle so gateway `afterInit`/handlers see it.
 */
export async function buildDoRuntime(
  rootModule: Type,
  ctx: DoStateLike,
  env: Record<string, unknown>,
): Promise<DoRuntime> {
  const { container, routeManager, loader } = await bootstrap(rootModule);

  // Init binding refs from env directly (no request middleware inside a DO).
  // Enumerate per-instance useValue providers across ALL module buckets — two
  // same-type binding modules share one token but live in distinct buckets, so
  // resolving the token would return only the first and leave the rest uninitialized.
  for (const value of container.getUseValues()) {
    if (value instanceof EnvRef) value._initialize(env);
    else if (value instanceof BindingRef) value._initialize(env[value.bindingName]);
  }

  const registry = new CfRoomRegistry(ctx);
  const driver = local();
  driver.bind(registry);
  const server = new WsServerImpl(driver);

  try {
    const holder = container.resolve(WS_SERVER);
    if (holder instanceof WsServerHolder) holder.setTarget(server);
  } catch {
    // CloudflareWebSocketModule not imported — gateways won't have a server.
  }

  const app = new VelaApplication(container, routeManager);
  app.setInstances(await loader.resolveAllInstances());
  await app.callOnModuleInit();
  await app.callOnApplicationBootstrap();

  // The entrypoint registry is the transport contract: one 'websocket' entry
  // per discovered gateway ({ meta: { path, dispatcher } }). Built by
  // callOnApplicationBootstrap(), so this slim no-routes path has it too.
  const wsEntrypoints = app.entrypoints.ofKind<WsEntrypointMeta>('websocket');
  const dispatcher = wsEntrypoints[0]?.meta.dispatcher ?? app.get(WsDispatcher);
  registry.setFrameLimitResolver((path) => dispatcher.getGatewayMaxFrameBytes(path));
  registry.setDeliveryAuthorizer((client) => {
    const path = (client as { readonly path?: string }).path ?? '';
    return dispatcher.authorizeDelivery(path, client);
  });

  // Live queries: wire the SQLite cursor log + local driver mode and replay
  // hibernation-persisted subscriptions into the fresh engine.
  const live = initDoLive(app, container, ctx);

  return {
    // Zero gateways still yields a live dispatcher (module imported, nothing
    // decorated) — fall back to resolving it directly.
    dispatcher,
    registry,
    server,
    gatewayPaths: wsEntrypoints.map((ep) => ep.meta.path),
    live,
    close: (signal?: string) => app.close(signal),
  };
}
