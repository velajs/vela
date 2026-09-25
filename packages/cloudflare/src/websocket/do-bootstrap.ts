import type { DynamicModule, Type, VelaEnv } from '@velajs/vela';
import type { Container, RuntimeAdapter } from '@velajs/vela/module-kit';
import { local, readWsEntrypointMeta, WsDispatcher, WsServerImpl } from '@velajs/vela/websocket';
import type { GatewayDelivery, WsServer } from '@velajs/vela/websocket';
import type { LiveEngine } from '@velajs/vela/live';
import { createDurableObjectContext } from '../durable-object/boot';
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

/** Options of {@link buildDoRuntime}. */
export interface DoRuntimeOptions {
  /** The object's environment, seeded as `ENV`. */
  env: VelaEnv;
  /** Runtime adapters of the app definition; their `configureContainer` runs in the object. */
  adapters?: readonly RuntimeAdapter[];
  /** The object's native state, injected as `DO_STATE`, `DO_STORAGE` and `DO_ID`. */
  state?: DurableObjectState;
}

/**
 * The application context of a WebSocket Durable Object, booted as every
 * Vela Durable Object is (`VelaFactory.createApplicationContext`, without the
 * HTTP routes it never serves): its `env` is seeded as the global ENV before
 * providers construct, next to this object's platform. `WebSocketModule`
 * builds its server over this object's sockets, `Gateways` pushes to this
 * object's room locally and forwards other rooms to their objects, and
 * `LiveModule` delivers locally with a SQLite cursor log when the class is
 * SQLite-backed. `onModuleInit`/`onApplicationBootstrap` run, so
 * `WsDispatcher` discovers the gateways.
 */
export async function buildDoRuntime(
  rootModule: Type | DynamicModule,
  ctx: DoStateLike,
  options: DoRuntimeOptions,
): Promise<DoRuntime> {
  const registry = new CfRoomRegistry(ctx);
  const driver = local();
  driver.bind(registry);
  const server = new WsServerImpl(driver);

  const context = await createDurableObjectContext(rootModule, {
    env: options.env,
    adapters: options.adapters,
    state: options.state,
    platform: () => ({
      websocket: {
        createServer: () => server,
        deliver: (delivery) => deliverFromDurableObject(ctx, options.env, registry, delivery),
      },
      live: durableObjectLivePlatform(ctx),
    }),
  });
  try {
    if (!context.getContainer().has(WsDispatcher)) {
      throw new Error(
        '[vela] A WebSocket Durable Object serves the gateways of WebSocketModule: import ' +
          'WebSocketModule.forRoot() from @velajs/vela/websocket in the application it is built from.',
      );
    }

    // The entrypoint registry is the transport contract: one 'websocket' entry
    // per discovered gateway ({ meta: { path, dispatcher } }), built with the
    // context's lifecycle hooks.
    const wsEntrypoints = context.entrypoints.ofKind('websocket', readWsEntrypointMeta);
    const dispatcher = wsEntrypoints[0]?.meta.dispatcher ?? context.get(WsDispatcher);
    registry.setSendPolicyResolver(
      (path) => wsEntrypoints.find((entry) => entry.meta.path === path)?.meta.options.sendPolicy,
    );
    registry.setFrameLimitResolver((path) => dispatcher.getGatewayMaxFrameBytes(path));
    registry.setDeliveryAuthorizer((client) => {
      const path = client instanceof CfWsClient ? client.path : '';
      return dispatcher.authorizeDelivery(path, client);
    });

    // Live queries: replay hibernation-persisted subscriptions into the fresh engine.
    const live = initDoLive(context, ctx, registry);

    return {
      container: context.getContainer(),
      // Zero gateways still yields a live dispatcher (module imported, nothing
      // decorated) — fall back to resolving it directly.
      dispatcher,
      registry,
      server,
      gatewayPaths: wsEntrypoints.map((ep) => ep.meta.path),
      live,
      close: (signal?: string) => context.close(signal),
    };
  } catch (error) {
    await context.dispose().catch(() => {});
    throw error;
  }
}
