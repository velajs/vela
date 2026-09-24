import { VelaApplication } from '@velajs/vela';
import { bootstrap } from '@velajs/vela/internal';
import type { DynamicModule, Type, VelaEnv } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';
import { local, readWsEntrypointMeta, WsDispatcher, WsServerImpl } from '@velajs/vela/websocket';
import type { GatewayDelivery, WsServer } from '@velajs/vela/websocket';
import type { LiveEngine } from '@velajs/vela/live';
import { registerCloudflarePlatform } from '../platform';
import { CfWsClient } from './cf-ws-client';
import { CfRoomRegistry } from './cf-room-registry';
import { durableObjectLivePlatform, initDoLive } from './do-live';
import type { DoStateLike } from './do-state';
import { gatewayRoomObject } from './worker-transport';

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

/** Whether a Durable Object id names this object. */
function isThisObject(id: unknown, ctx: DoStateLike): boolean {
  const equals: unknown =
    typeof id === 'object' && id !== null ? Reflect.get(id, 'equals') : undefined;
  if (typeof equals === 'function') return Reflect.apply(equals, id, [ctx.id]) === true;
  return String(id) === ctx.id.toString();
}

/**
 * A `Gateways` push from inside a WebSocket Durable Object: this object's own
 * gateway room is delivered to its sockets; any other room goes to that
 * room's object over its broadcast RPC, as from the Worker.
 */
async function deliverFromDurableObject(
  ctx: DoStateLike,
  env: VelaEnv,
  registry: CfRoomRegistry,
  { gatewayPath, binding, room, command }: GatewayDelivery,
): Promise<void> {
  const target = gatewayRoomObject(env, gatewayPath, binding, room);
  if (isThisObject(target.id, ctx)) await registry.deliverLocal(command);
  else await target.call('broadcast', command);
}

/**
 * Slim DI bootstrap for the Durable Object isolate: wires the container and runs
 * `OnModuleInit`/`OnApplicationBootstrap` (so `WsDispatcher` discovers gateways)
 * WITHOUT building the Hono app/routes the DO never serves. The DO's `env` is
 * seeded as the global ENV before providers construct, next to this object's
 * platform: `WebSocketModule` builds its server over this object's sockets,
 * `Gateways` pushes to this object's room locally and forwards other rooms to
 * their objects, and `LiveModule` delivers locally with a SQLite cursor log
 * when the class is SQLite-backed.
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
        websocket: {
          createServer: () => server,
          deliver: (delivery) => deliverFromDurableObject(ctx, options.env, registry, delivery),
        },
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
