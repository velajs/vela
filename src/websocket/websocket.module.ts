import { defineProvider } from '../container/types';
import { defineModule } from '../module/define-module';
import { WsDispatcher } from './ws-dispatcher';
import { WsServerImpl } from './ws-server';
import { InMemoryRoomRegistry, local, type RoomRegistry, type SyncDriver } from './ws-sync';
import { WS_MODULE_OPTIONS, WS_ROOM_REGISTRY, WS_SERVER, WS_SYNC_DRIVER } from './websocket.tokens';

export interface WebSocketModuleOptions {
  /**
   * Cross-instance sync driver. Defaults to `local()` (single instance). Use
   * `durableObject()` from `@velajs/cloudflare` or `redis()` from
   * `@velajs/vela/websocket-node` for horizontal scale.
   */
  sync?: SyncDriver;
  /**
   * Local room registry the transport reads/writes. Defaults to the in-memory
   * implementation (node/bun/deno); the Cloudflare transport supplies its own.
   */
  registry?: RoomRegistry;
}

/**
 * Registers the WebSocket gateway machinery: the message dispatcher (discovers
 * `@WebSocketGateway` classes via DiscoveryService at bootstrap), the room
 * registry, the sync driver, and the `@WebSocketServer()`-injected server
 * handle.
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
        useFactory: (driver: SyncDriver) => new WsServerImpl(driver),
        inject: [WS_SYNC_DRIVER],
      }),
      WsDispatcher,
    ],
    exports: [WS_SERVER, WS_SYNC_DRIVER, WS_ROOM_REGISTRY, WsDispatcher],
  }),
});

export class WebSocketModule extends ConfigurableModuleClass {}
