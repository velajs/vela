// Decorators
export {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
} from './websocket.decorators';

// Module
export { WebSocketModule } from './websocket.module';
export type { WebSocketModuleOptions } from './websocket.module';

// Dispatcher (injected/called by transports) + the 'websocket' entrypoint meta
export { WsDispatcher, type WsEntrypointMeta } from './ws-dispatcher';

// Server handle + rooms + sync
export { WsServerImpl, BroadcastOperatorImpl } from './ws-server';
export { InMemoryRoomRegistry, local } from './ws-sync';
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
  SubscribeMessageMetadata,
  WsExecutionContext,
  WsArgumentsHost,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from './websocket.types';
