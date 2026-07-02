import type { ProviderOptions, Type } from '../container/types';
import type { DynamicModule } from '../module/types';
import { WsDispatcher } from './ws-dispatcher';
import { WsServerImpl } from './ws-server';
import { InMemoryRoomRegistry, local, type RoomRegistry, type SyncDriver } from './ws-sync';
import {
  WS_MODULE_OPTIONS,
  WS_ROOM_REGISTRY,
  WS_SERVER,
  WS_SYNC_DRIVER,
} from './websocket.tokens';

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
 * `@WebSocketGateway` classes at bootstrap), the room registry, the sync driver,
 * and the `@WebSocketServer()`-injected server handle. Mirrors
 * `CacheModule.forRoot` / `ScheduleModule.forRoot`.
 */
// forRoot() carries non-serializable per-call state (a fresh registry/driver/
// server), so each call is its own module instance. A unique key prevents the
// module loader from deduping two distinct configurations into one (which would
// silently discard the second registry/server).
let instanceCounter = 0;

export class WebSocketModule {
  static forRoot(options: WebSocketModuleOptions = {}): DynamicModule {
    const registry = options.registry ?? new InMemoryRoomRegistry();
    const driver = options.sync ?? local();
    driver.bind(registry);
    const server = new WsServerImpl(driver);

    const providers: Array<Type | ProviderOptions> = [
      { provide: WS_MODULE_OPTIONS, useValue: options },
      { provide: WS_ROOM_REGISTRY, useValue: registry },
      { provide: WS_SYNC_DRIVER, useValue: driver },
      { provide: WS_SERVER, useValue: server },
      WsDispatcher,
    ];

    return {
      module: WebSocketModule,
      key: `${driver.kind}#${(instanceCounter += 1)}`,
      providers,
      exports: [WS_SERVER, WS_SYNC_DRIVER, WS_ROOM_REGISTRY, WsDispatcher],
    };
  }
}
