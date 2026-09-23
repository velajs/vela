import { InjectionToken } from '../container/types';
import type { WebSocketModuleOptions } from './websocket.module';
import type { RoomRegistry, SyncDriver } from './ws-sync';
import type { WsServer } from './websocket.types';

// Free-form metadata keys — same string-token convention as ON_EVENT_METADATA / CRON_METADATA.
export const WS_GATEWAY_METADATA = 'vela:ws-gateway';
export const WS_SUBSCRIBE_METADATA = 'vela:ws-subscribe';
export const WS_RESERVED_METADATA = 'vela:ws-reserved';

/**
 * Event names starting with this prefix are RESERVED for framework modules
 * (`$live`, …): app gateways may not subscribe to them, and inbound frames
 * carrying them route to `@ReservedWsEvent` handlers instead of gateways.
 */
export const RESERVED_WS_EVENT_PREFIX = '$';

// WebSocket parameter-decorator kinds — parallel to `ParamType` for HTTP, keyed
// by the WS argument resolver rather than the Hono-bound HTTP one.
export const WsParamType = {
  SOCKET: 'ws_socket',
  BODY: 'ws_body',
  SERVER: 'ws_server',
} as const;
export type WsParamType = (typeof WsParamType)[keyof typeof WsParamType];

/**
 * The connected gateway server handle. Injected into gateways/controllers via
 * `@WebSocketServer()` (constructor injection only — the container has no
 * property-injection pass) or `@Inject(WS_SERVER)`.
 */
export const WS_SERVER = /* @__PURE__ */ new InjectionToken<WsServer>('WS_SERVER');

/** The active cross-instance sync driver (`local()` by default). */
export const WS_SYNC_DRIVER = /* @__PURE__ */ new InjectionToken<SyncDriver>('WS_SYNC_DRIVER');

/** The local room-membership registry a transport reads/writes. */
export const WS_ROOM_REGISTRY = /* @__PURE__ */ new InjectionToken<RoomRegistry>(
  'WS_ROOM_REGISTRY',
);

// forRoot() options carrier — a typed InjectionToken like every other module
// options token (the raw-string form was the odd one out).
export const WS_MODULE_OPTIONS = /* @__PURE__ */ new InjectionToken<WebSocketModuleOptions>(
  'WS_MODULE_OPTIONS',
);
