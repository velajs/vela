import { VelaApplication } from '@velajs/vela';
import { bootstrap } from '@velajs/vela/internal';
import type { DynamicModule, Type, VelaEnv } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';
import { local, readWsEntrypointMeta, WsDispatcher, WsServerImpl } from '@velajs/vela/websocket';
import type { WsServer } from '@velajs/vela/websocket';
import type { LiveEngine } from '@velajs/vela/live';
import { registerCloudflarePlatform } from '../platform';
import { CfWsClient } from './cf-ws-client';
import { CfRoomRegistry } from './cf-room-registry';
import { durableObjectLivePlatform, initDoLive } from './do-live';
import type { DoStateLike } from './do-state';

export interface DoRuntime {
  /** The Durable Object application's container. */
  container: Container;
  dispatcher: WsDispatcher;
  registry: CfRoomRegistry;
  /** The server gateways inject: it broadcasts to this object's hibernatable sockets. */
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
 * seeded as the global ENV before providers construct, next to this object's
 * platform: `WebSocketModule` builds its server over this object's sockets,
 * and `LiveModule` delivers locally with a SQLite cursor log when the class is
 * SQLite-backed.
 */
export async function buildDoRuntime(
  rootModule: Type | DynamicModule,
  ctx: DoStateLike,
  options: { env: VelaEnv },
): Promise<DoRuntime> {
  const registry = new CfRoomRegistry(ctx);
  const driver = local();
  driver.bind(registry);
  const server = new WsServerImpl(driver);

  const { container, routeManager, loader } = await bootstrap(rootModule, {
    configureContainer: (target) => {
      registerCloudflarePlatform(target, options.env, {
        websocket: { createServer: () => server },
        live: durableObjectLivePlatform(ctx),
      });
    },
  });
  if (!container.has(WsDispatcher)) {
    throw new Error(
      '[vela] A WebSocket Durable Object serves the gateways of WebSocketModule: import ' +
        'WebSocketModule.forRoot() from @velajs/vela/websocket in the application it is built from.',
    );
  }

  const app = new VelaApplication(container, routeManager);
  app.setInstances(await loader.resolveAllInstances());
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

  // Live queries: replay hibernation-persisted subscriptions into the fresh engine.
  const live = initDoLive(app, ctx, registry);

  return {
    container,
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
