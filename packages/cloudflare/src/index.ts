import './vela-env';
// Factory & Application
export type { CloudflareRoot } from './root-module';
export { durableObjectRoomName } from './websocket/room-id';
export {
  cloudflareAdapter,
  createCloudflareApp,
  createCloudflareWorker,
} from './cloudflare-factory';
export type {
  CloudflareAppOptions,
  CloudflareWorkerOptions,
  CreateCloudflareAppOptions,
} from './cloudflare-factory';
export { CloudflareApplication } from './cloudflare-application';
export type { MountOpenApiOptions } from './cloudflare-application';

// Name-based binding factories: { binding } references resolved from each
// application's ENV when used
export { d1, durableObject, kv, queue, r2, rateLimit } from './bindings';

// Services
export {
  KVCacheStore,
  KVCacheInvalidationStore,
  kvCache,
  kvCacheInvalidation,
} from './services/kv-cache.store';
export type { KVNamespaceSource } from './services/kv-cache.store';

// Feature-flag drivers (implement @velajs/feature-flags' FeatureFlagDriver contract)
export { FlagshipFlagDriver, flagshipFlagDriver } from './services/flagship-flag.driver';
export type { FlagshipBinding, FlagshipFlagDriverOptions } from './services/flagship-flag.driver';
export { KvFlagDriver, kvFlagDriver } from './services/kv-flag.driver';
export type { KvFlagDriverOptions } from './services/kv-flag.driver';

// Decorators
export { QueueConsumer } from './decorators/queue-consumer';

// Cron triggers run core @Cron jobs; this request-scoped token exposes the trigger.
export { CLOUDFLARE_SCHEDULED_EVENT } from './scheduled-event';
export type { CloudflareScheduledEvent, ScheduledEvent } from './scheduled-event';

// WebSocket: the adapter wires WebSocketModule to a Durable Object per gateway room;
// this helper pushes to a room from the Worker.
export { broadcastToRoom } from './websocket/index';
export type { BroadcastNamespace } from './websocket/index';

// Durable Object PITR (point-in-time recovery) — raw bookmark wrappers + the RPC
// contract types. The WS Durable Object exposes `pitrCurrentBookmark`,
// `pitrBookmarkForTime`, `pitrArmRestore` (intra-worker-only RPC); studio's
// `@velajs/studio/cloudflare` port wraps these into a `TimeTravelPort`.
export {
  readDoPitrBookmark,
  armDoPitr,
  DoPitrUnavailableError,
  isDoPitrUnavailable,
} from './websocket/index';
export type {
  DoPitrStorage,
  DoPitrBookmarkRead,
  DoPitrArmOptions,
  DoPitrArmResult,
  VelaDoPitrRpc,
  DoPitrId,
  DoPitrNamespace,
} from './websocket/index';

// Live queries (Durable Object transport for @velajs/vela/live)
export { DoCursorLog, durableObjectLive, liveInvalidateToRoom } from './websocket/index';
export type { CfLiveDriver, DurableObjectLiveOptions, LiveNamespace } from './websocket/index';

// Types
export type { QueueConsumerMetadata } from './decorators/queue-consumer';

// Distributed abuse control (Cloudflare Workers Rate Limiting binding)
export { cloudflareRateLimitStore } from './rate-limit/index';
export type {
  CloudflareRateLimitBinding,
  CloudflareRateLimitStoreOptions,
} from './rate-limit/index';

// Strict global single-use nonces (SQLite Durable Object)
export { durableObjectNonceStore } from './nonce/index';
export type { DurableObjectNonceNamespace, DurableObjectNonceStoreOptions } from './nonce/index';
