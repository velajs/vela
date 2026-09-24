import { defineProvider } from '../container/types';
import { defineModule } from '../module/define-module';
import type { DynamicModule } from '../registry/types';
import { Gateways } from './gateways';
import { WebSocketPlatform, WebSocketRoutesModule } from './upgrade-routes';
import { WsDispatcher } from './ws-dispatcher';
import { RemoteSocketsWsServer, WsServerImpl } from './ws-server';
import { InMemoryRoomRegistry, local, type RoomRegistry, type SyncDriver } from './ws-sync';
import { WS_MODULE_OPTIONS, WS_ROOM_REGISTRY, WS_SERVER, WS_SYNC_DRIVER } from './websocket.tokens';

export interface WebSocketModuleOptions {
  /**
   * Cross-instance sync driver. Defaults to `local()` (single instance). Use
   * `redis()` from `@velajs/vela/websocket-node` for horizontal scale. A
   * platform transport that owns delivery (Cloudflare's Durable Object per
   * room) may ignore it.
   */
  sync?: SyncDriver;
  /**
   * Local room registry the sync driver reads/writes. Defaults to the
   * in-memory implementation.
   */
  registry?: RoomRegistry;
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
 * The instance key derives from the sync driver kind: two `forRoot()` calls
 * with the same driver kind dedup (HMR-idempotent); pass an explicit `key`
 * to run multiple same-kind instances side by side.
 */
const { ConfigurableModuleClass } = defineModule<WebSocketModuleOptions>({
  name: 'WebSocket',
  optionsToken: WS_MODULE_OPTIONS,
  key: (options) => `ws#${options.sync?.kind ?? 'local'}`,
  setup: ({ OPTIONS }) => ({
    imports: [WebSocketRoutesModule],
    providers: [
      defineProvider(WS_ROOM_REGISTRY, {
        useFactory: (o: WebSocketModuleOptions) => o.registry ?? new InMemoryRoomRegistry(),
        inject: [OPTIONS],
      }),
      defineProvider(WS_SYNC_DRIVER, {
        useFactory: (o: WebSocketModuleOptions, registry: RoomRegistry) => {
          const driver = o.sync ?? local();
          driver.bind(registry);
          return driver;
        },
        inject: [OPTIONS, WS_ROOM_REGISTRY],
      }),
      defineProvider(WS_SERVER, {
        useFactory: (driver: SyncDriver, { transport }: WebSocketPlatform) => {
          if (transport?.createServer) return transport.createServer(driver);
          // A transport that delivers pushes elsewhere keeps no sockets here.
          if (transport?.deliver) return new RemoteSocketsWsServer();
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
