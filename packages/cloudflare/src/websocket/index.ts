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

// Live queries: durable cursor log + DO-routed invalidation driver
export { DoCursorLog, initDoLive, liveInvalidateToRoom } from './do-live';
export { CfLiveDriver, durableObjectLive } from './live-driver';
export type { DurableObjectLiveOptions, LiveInvalidateStub, LiveNamespace } from './live-driver';

// Transport internals (advanced use / testing)
export { CfWsClient } from './cf-ws-client';
export { CfRoomRegistry } from './cf-room-registry';
export { DoWebSocketHost, type WsConnectionPrincipal } from './do-websocket-host';
export { buildDoRuntime } from './do-bootstrap';
export type { DoRuntime } from './do-bootstrap';
export { FORWARDED_UPGRADE_HEADERS, workerWebSocketTransport } from './worker-transport';
export { roomTag, connTag, durableObjectRoomName, roomToDurableId } from './room-id';
export { MAX_WS_ATTACHMENT_BYTES } from './do-state';
export type { DoStateLike, SqlStorageLike, WsLike, WsAttachment } from './do-state';
