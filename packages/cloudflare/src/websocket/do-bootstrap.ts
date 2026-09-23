import { bootstrap, VelaApplication } from '@velajs/vela';
import type { DynamicModule, Type, VelaEnv } from '@velajs/vela';
import {
  local,
  readWsEntrypointMeta,
  WsDispatcher,
  WsServerImpl,
  WS_SERVER,
} from '@velajs/vela/websocket';
import type { WsServer } from '@velajs/vela/websocket';
import type { LiveEngine } from '@velajs/vela/live';
import { registerCloudflareEnvironment } from '../environment';
import { CfWsClient } from './cf-ws-client';
import { CfRoomRegistry } from './cf-room-registry';
import { initDoLive, initializeDoLiveResources } from './do-live';
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
 * WITHOUT building the Hono app/routes the DO never serves. The DO's `env` is
 * seeded as the global ENV before providers construct, and the ctx-backed server
 * is bound before bootstrap lifecycle so gateway `afterInit`/handlers see it.
 */
export async function buildDoRuntime(
  rootModule: Type | DynamicModule,
  ctx: DoStateLike,
  options: { env: VelaEnv },
): Promise<DoRuntime> {
  const { container, routeManager, loader } = await bootstrap(rootModule, {
    configureContainer: (container) => {
      registerCloudflareEnvironment(container, options.env);
    },
  });

  const registry = new CfRoomRegistry(ctx);
  const driver = local();
  driver.bind(registry);
  const server = new WsServerImpl(driver);

  if (container.has(WS_SERVER)) {
    const holder = await container.resolveAsync(WS_SERVER);
    // The core WebSocketModule's server broadcasts through its own sync driver,
    // which never reaches this Durable Object's hibernatable sockets.
    if (!(holder instanceof WsServerHolder)) {
      throw new Error(
        '[vela] The WebSocket Durable Object found a WS_SERVER from the core WebSocketModule, ' +
          'which cannot reach Durable Object sockets. On Cloudflare, import ' +
          'CloudflareWebSocketModule.forRoot() instead of WebSocketModule.forRoot().',
      );
    }
    holder.setTarget(server);
  }

  const app = new VelaApplication(container, routeManager);
  app.setInstances(await loader.resolveAllInstances());
  initializeDoLiveResources(container, ctx);
  await app.callOnModuleInit();
  await app.callOnApplicationBootstrap();

  // The entrypoint registry is the transport contract: one 'websocket' entry
  // per discovered gateway ({ meta: { path, dispatcher } }). Built by
  // callOnApplicationBootstrap(), so this slim no-routes path has it too.
  const wsEntrypoints = app.entrypoints.ofKind('websocket', readWsEntrypointMeta);
  const dispatcher = wsEntrypoints[0]?.meta.dispatcher ?? app.get(WsDispatcher);
  registry.setSendPolicyResolver(
    (path) => wsEntrypoints.find((entry) => entry.meta.path === path)?.meta.options.sendPolicy,
  );
  registry.setFrameLimitResolver((path) => dispatcher.getGatewayMaxFrameBytes(path));
  registry.setDeliveryAuthorizer((client) => {
    const path = client instanceof CfWsClient ? client.path : '';
    return dispatcher.authorizeDelivery(path, client);
  });

  // Live queries: wire the SQLite cursor log + local driver mode and replay
  // hibernation-persisted subscriptions into the fresh engine.
  const live = initDoLive(app, ctx, registry);

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
