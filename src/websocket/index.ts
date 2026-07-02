// DO base class (imports `cloudflare:workers` — only runs in workerd).
export { VelaWebSocketDurableObject } from './websocket.durable-object';

// Module + server-initiated emit helper
export { CloudflareWebSocketModule } from './cloudflare-websocket.module';
export { broadcastToRoom } from './broadcast';

// Transport internals (advanced use / testing)
export { CfWsClient } from './cf-ws-client';
export { CfRoomRegistry } from './cf-room-registry';
export { DoWebSocketHost } from './do-websocket-host';
export { WsServerHolder } from './ws-server-holder';
export { buildDoRuntime } from './do-bootstrap';
export type { DoRuntime } from './do-bootstrap';
export { registerWebSocketRoutes, collectWsGatewayRoutes } from './websocket-routing';
export type { WsGatewayRoute } from './websocket-routing';
export { roomTag, connTag, roomToDurableId } from './room-id';
export type { DoStateLike, WsLike, WsAttachment } from './do-state';
