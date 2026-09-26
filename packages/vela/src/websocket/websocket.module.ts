import { defineProvider } from '../container/types';
import { Container } from '../container/container';
import { defineModule } from '../module/define-module';
import { referenceKey } from '../module/reference-key';
import type { DynamicModule } from '../registry/types';
import { Gateways } from './gateways';
import { WebSocketPlatform, WebSocketRoutesModule } from './upgrade-routes';
import { WsDispatcher } from './ws-dispatcher';
import {
  ForwardedUpgradesWsServer,
  forwardedSocketsUnreachable,
  RemoteSocketsWsServer,
  WsServerImpl,
} from './ws-server';
import { InMemoryRoomRegistry, local, type RoomRegistry, type SyncDriver } from './ws-sync';
import { WS_MODULE_OPTIONS, WS_ROOM_REGISTRY, WS_SERVER, WS_SYNC_DRIVER } from './websocket.tokens';

export interface WebSocketModuleOptions {
  /**
   * Cross-instance sync driver. Defaults to `local()` (single instance). Use
   * `redis()` from `@velajs/vela/websocket-node` for horizontal scale. A
   * platform transport that owns delivery (Cloudflare's Durable Object per
   * room) may ignore it. Supply an instance for one application, or a factory
   * that constructs a fresh instance for each application.
   */
  sync?: SyncDriver | (() => SyncDriver | Promise<SyncDriver>);
  /**
   * Local room registry the sync driver reads/writes. Defaults to the
   * in-memory implementation. An instance can be shared within one application;
   * use a factory when reusing configuration across applications.
   */
  registry?: RoomRegistry | (() => RoomRegistry | Promise<RoomRegistry>);
}

// Drivers bind a mutable registry, and registries hold sockets. Neither may acquire
// a second application owner, including when a factory returns a captured singleton.
const ownedDrivers = new WeakMap<SyncDriver, string>();
const ownedRegistries = new WeakMap<RoomRegistry, string>();
const driverRegistries = new WeakMap<SyncDriver, RoomRegistry>();

function own<T extends object>(
  value: T,
  owners: WeakMap<T, string>,
  container: Container,
  name: string,
): T {
  if (value === null || typeof value !== 'object')
    throw new TypeError(`WebSocket ${name} must be an object or a factory returning one.`);
  // These singleton factories receive the application container. Keep only its
  // opaque identity, so a supplied resource cannot retain a disposed container.
  const application = referenceKey(container);
  const owner = owners.get(value);
  if (owner && owner !== application)
    throw new Error(
      `WebSocket ${name} was already assigned to an application. Supply a fresh instance or return one from a factory.`,
    );
  owners.set(value, application);
  return value;
}

/**
 * Registers the WebSocket gateway machinery: the message dispatcher (discovers
 * `@WebSocketGateway` classes via DiscoveryService at bootstrap), the room
 * registry, the sync driver, the `@WebSocketServer()`-injected server handle,
 * and `Gateways`, which pushes to a gateway's rooms from anywhere in the
 * application.
 *
 * The platform decides where sockets live. A runtime adapter registers the
 * global `WS_TRANSPORT` (`@velajs/cloudflare` does): its `createServer` builds
 * the server gateways inject, its `deliver` carries `Gateways` pushes to the
 * isolate that holds each room, and a forwarding transport receives each
 * binding-backed gateway's authenticated upgrade from the route this module
 * mounts. Without a transport, a host serves the gateways in this process
 * (`registerWebSocketGateways` on node, Bun and Deno).
 *
 * Construction lives in chained provider factories — registry → driver
 * (bound to THAT registry) → server — so the single shared registry instance
 * is preserved and everything materializes at bootstrap's eager
 * instantiation, before any lifecycle hook or message dispatch.
 *
 * Options resolve per application. Drivers and registries may be supplied directly
 * or through factories; sharing them across application owners fails bootstrap.
 */
const { ConfigurableModuleClass } = defineModule<WebSocketModuleOptions>({
  name: 'WebSocket',
  optionsToken: WS_MODULE_OPTIONS,
  setup: ({ OPTIONS }) => ({
    imports: [WebSocketRoutesModule],
    providers: [
      defineProvider(WS_ROOM_REGISTRY, {
        useFactory: async (o: WebSocketModuleOptions, container: Container) =>
          own(
            typeof o.registry === 'function'
              ? await o.registry()
              : (o.registry ?? new InMemoryRoomRegistry()),
            ownedRegistries,
            container,
            'registry',
          ),
        inject: [OPTIONS, Container],
      }),
      defineProvider(WS_SYNC_DRIVER, {
        useFactory: async (
          o: WebSocketModuleOptions,
          registry: RoomRegistry,
          container: Container,
        ) => {
          const driver = own(
            typeof o.sync === 'function' ? await o.sync() : (o.sync ?? local()),
            ownedDrivers,
            container,
            'sync driver',
          );
          const bound = driverRegistries.get(driver);
          if (bound && bound !== registry)
            throw new Error('WebSocket sync driver is already bound to a different room registry.');
          if (!bound) {
            driver.bind(registry);
            driverRegistries.set(driver, registry);
          }
          return driver;
        },
        inject: [OPTIONS, WS_ROOM_REGISTRY, Container],
      }),
      defineProvider(WS_SERVER, {
        useFactory: (driver: SyncDriver, { transport }: WebSocketPlatform) => {
          if (transport?.createServer) return transport.createServer(driver);
          // A transport that delivers pushes elsewhere keeps no sockets here.
          if (transport?.deliver) return new RemoteSocketsWsServer();
          // Neither the transport nor the driver reaches a forwarded gateway's sockets.
          if (forwardedSocketsUnreachable(transport, driver)) {
            return new ForwardedUpgradesWsServer(driver);
          }
          return new WsServerImpl(driver);
        },
        inject: [WS_SYNC_DRIVER, WebSocketPlatform],
      }),
      WsDispatcher,
      Gateways,
    ],
    exports: [WS_SERVER, WS_SYNC_DRIVER, WS_ROOM_REGISTRY, WsDispatcher, Gateways],
  }),
});

type WebSocketModuleRegistration = Parameters<(typeof ConfigurableModuleClass)['forRoot']>[0];

export class WebSocketModule extends ConfigurableModuleClass {
  /** Register the gateway machinery; every option is optional. */
  static override forRoot(options: WebSocketModuleRegistration = {}): DynamicModule {
    return super.forRoot(options);
  }
}
