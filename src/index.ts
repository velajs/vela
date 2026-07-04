// Factory & Application
export { cloudflareAdapter, createCloudflareApp } from './cloudflare-factory';
export type { CreateCloudflareAppOptions } from './cloudflare-factory';
export { CloudflareApplication } from './cloudflare-application';
export type { MountOpenApiOptions } from './cloudflare-application';

// Modules
export { KVModule } from './modules/kv.module';
export { D1Module } from './modules/d1.module';
export { R2Module } from './modules/r2.module';
export { QueueModule } from './modules/queue.module';
export { DurableObjectModule } from './modules/durable-object.module';
export { AIModule } from './modules/ai.module';
export { VectorizeModule } from './modules/vectorize.module';
export { HyperdriveModule } from './modules/hyperdrive.module';
export { EnvModule } from './modules/env.module';

// Storage (multi-disk over R2 + presign proxy)
export {
  StorageModule,
  StorageService,
  StorageManagerService,
  StorageController,
  R2StorageDriver,
  STORAGE_OPTIONS,
} from './storage/index';
export type { StorageModuleOptions, DiskConfig, PresignedUrlConfig } from './storage/index';

// Services
export { KVService } from './services/kv.service';
export { KVCacheStore } from './services/kv-cache.store';
export { D1Service } from './services/d1.service';
export { R2Service } from './services/r2.service';
export { QueueService } from './services/queue.service';
export { DurableObjectService } from './services/durable-object.service';
export { AIService } from './services/ai.service';
export { VectorizeService } from './services/vectorize.service';
export { HyperdriveService } from './services/hyperdrive.service';
export { EnvService } from './services/env.service';

// Decorators
export { Env } from './decorators/env';
export { Scheduled } from './decorators/scheduled';
export { QueueConsumer } from './decorators/queue-consumer';

// WebSocket (Durable Object transport for the Vela WebSocketModule)
export {
  VelaWebSocketDurableObject,
  CloudflareWebSocketModule,
  broadcastToRoom,
} from './websocket/index';
export type { WsGatewayRoute } from './websocket/index';
// Re-export the core gateway API so a Cloudflare app can import it from one place.
export {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  WsException,
} from '@velajs/vela/websocket';
export type {
  WsClient,
  WsServer,
  WsResponse,
  WsMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@velajs/vela/websocket';

// Types
export type { CloudflareEnv, ScheduledRegistration, QueueRegistration } from './types';
export type { ScheduledMetadata } from './decorators/scheduled';
export type { QueueConsumerMetadata } from './decorators/queue-consumer';
