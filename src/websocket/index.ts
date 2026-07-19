// DO base class (imports `cloudflare:workers` — only runs in workerd).
export { VelaWebSocketDurableObject } from './websocket.durable-object';

// Durable Object PITR (point-in-time recovery) — raw capability wrappers +
// contract types. `cloudflare:workers`-free; wrapped by `@velajs/studio/cloudflare`.
export {
  readDoPitrBookmark,
  armDoPitr,
  DoPitrUnavailableError,
  isDoPitrUnavailable,
} from './do-pitr';
export type {
  DoPitrStorage,
  DoPitrBookmarkRead,
  DoPitrArmOptions,
  DoPitrArmResult,
  VelaDoPitrRpc,
  DoPitrId,
  DoPitrNamespace,
} from './do-pitr';

// Module + server-initiated emit helper
export { CloudflareWebSocketModule } from './cloudflare-websocket.module';
export { broadcastToRoom } from './broadcast';

// Live queries: durable cursor log + DO-routed invalidation driver
export {
  DoCursorLog,
  durableObjectCursorLog,
  durableObjectLive,
  initDoLive,
  initializeWorkerLive,
  liveInvalidateToRoom,
} from './do-live';
export type { CfLiveDriver, DurableObjectLiveOptions } from './do-live';

// Transport internals (advanced use / testing)
export { CfWsClient } from './cf-ws-client';
export { CfRoomRegistry } from './cf-room-registry';
export { DoWebSocketHost, type WsConnectionPrincipal } from './do-websocket-host';
export { WsServerHolder } from './ws-server-holder';
export { buildDoRuntime } from './do-bootstrap';
export type { DoRuntime } from './do-bootstrap';
export { registerWebSocketRoutes, collectWsGatewayRoutes } from './websocket-routing';
export type { WsGatewayRoute } from './websocket-routing';
export { roomTag, connTag, durableObjectRoomName, roomToDurableId } from './room-id';
export { MAX_WS_ATTACHMENT_BYTES } from './do-state';
export type { DoStateLike, SqlStorageLike, WsLike, WsAttachment } from './do-state';
