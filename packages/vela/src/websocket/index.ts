// Decorators
export {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  ReservedWsEvent,
} from './websocket.decorators';

// Module
export { WebSocketModule } from './websocket.module';
export type { WebSocketModuleOptions } from './websocket.module';

// Dispatcher (injected/called by transports) + the 'websocket' entrypoint meta
export { WsDispatcher, readWsEntrypointMeta, type WsEntrypointMeta } from './ws-dispatcher';
export {
  DEFAULT_WS_MAX_FRAME_BYTES,
  DEFAULT_WS_MAX_JOINED_ROOMS,
  DEFAULT_WS_MAX_ROOM_ID_BYTES,
  assertWebSocketRoomId,
  createWebSocketUpgradeGate,
  isWebSocketOriginAllowed,
  normalizeWebSocketUpgradeIdentity,
  webSocketFrameFits,
  resolveGatewayRoomId,
  resolveGatewayRoomParam,
  resolveMaxFrameBytes,
} from './gateway-routing';
export type {
  AuthenticatedWebSocketUpgrade,
  WebSocketUpgradeGate,
  WebSocketUpgradeGateway,
} from './gateway-routing';
export {
  issueWebSocketTicket,
  verifyAndConsumeWebSocketTicket,
  WEBSOCKET_TICKET_AUDIENCE,
  WEBSOCKET_TICKET_PURPOSE,
  WEBSOCKET_TICKET_MAX_TTL_MS,
} from './socket-ticket';
export type {
  WebSocketTicketPrincipalType,
  WebSocketTicketPrincipal,
  WebSocketTicketClaim,
  WebSocketTicketNonceStore,
  IssueWebSocketTicketOptions,
  VerifyWebSocketTicketOptions,
} from './socket-ticket';

// Server handle + rooms + sync
export { WsServerImpl, BroadcastOperatorImpl } from './ws-server';
export {
  InMemoryRoomRegistry,
  assertBroadcastCommandFits,
  broadcastCommandFits,
  local,
  MAX_WS_SYNC_ENVELOPE_OVERHEAD_BYTES,
  webSocketSyncEnvelopeFits,
} from './ws-sync';
export type { SyncDriver, RoomRegistry } from './ws-sync';

// Execution context + exceptions
export { buildWsExecutionContext } from './ws-execution-context';
export { WsException, toErrorFrame } from './ws-exception';

// Argument resolution (used by transports building custom dispatch)
export { resolveWsArgs } from './ws-argument-resolver';

// Tokens
export {
  WS_SERVER,
  WS_SYNC_DRIVER,
  WS_ROOM_REGISTRY,
  WS_MODULE_OPTIONS,
  WS_GATEWAY_METADATA,
  WS_SUBSCRIBE_METADATA,
  WS_RESERVED_METADATA,
  RESERVED_WS_EVENT_PREFIX,
  WsParamType,
} from './websocket.tokens';

// Types
export type {
  WsClient,
  WsServer,
  WsMessage,
  WsResponse,
  BroadcastCommand,
  BroadcastOperator,
  WebSocketGatewayOptions,
  WebSocketPrincipal,
  WebSocketUpgradeIdentity,
  WebSocketUpgradeAuthenticationContext,
  UpgradeAuthenticator,
  SubscribeMessageMetadata,
  ReservedWsEventMetadata,
  ReservedWsEventHandler,
  WsExecutionContext,
  WsArgumentsHost,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from './websocket.types';

export { trySendWebSocketFrame } from './ws-send';
export { WebSocketSendGate, readWebSocketEnvelope } from '@velajs/live-protocol';
export type { WebSocketSendPolicy, WebSocketSendResult } from '@velajs/live-protocol';
export { WsMessageQueue } from './ws-message-queue';
