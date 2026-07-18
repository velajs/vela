// @velajs/vela/live — first-party live-query subsystem (tag-based realtime
// reactivity), authored entirely on the public API plus the shared wire
// package @velajs/live-protocol (the live-openness audit test enforces it).
// Subpath-only, like @velajs/vela/queue: the main barrel stays lean and the
// name stays free for platform packages.
export { LiveModule } from './live.module';
export { LiveResolver, LiveQuery, getLiveQueries } from './live.decorators';
export { LiveEngine, LIVE_SUBS_DATA_KEY, readPersistedLiveSubscriptions } from './live.engine';
export {
  LiveInvalidation,
  localLive,
  perAppLiveDriver,
  stampCommitHeaders,
} from './live.invalidation';
export { InMemoryCursorLog } from './live.cursor';
export { encodeSubscriptionUpdate } from './live.delta';
export { PresenceService, PresenceResolver, presenceTag, PRESENCE_ROSTER_QUERY } from './presence';
export type { PresenceMember } from './presence';
export {
  LIVE_DRIVER,
  LIVE_CURSOR_LOG,
  LIVE_MODULE_OPTIONS,
  LIVE_RESOLVER_METADATA,
  LIVE_QUERY_METADATA,
} from './live.tokens';
export type {
  CommitStamp,
  CursorLog,
  InvalidationCommand,
  LiveDriver,
  LiveDeliveryAuthorizationContext,
  LiveEntrypointMeta,
  LiveIdentity,
  LiveInvalidationSink,
  LiveModuleOptions,
  LivePresenceOptions,
  LiveQueryContext,
  LiveQueryMetadata,
  LiveQueryOptions,
  LiveResolverMetadata,
  ResumeVerdict,
  SubscriptionRecord,
} from './live.types';

// The wire contract (frames, delta codec, headers) is re-exported so app code
// and transports need a single import surface.
export {
  LIVE_PROTOCOL,
  LIVE_EVENT,
  LIVE_ERROR_CODES,
  COMMIT_CURSOR_HEADER,
  COMMIT_EPOCH_HEADER,
  DEFAULT_KEY_FIELD,
  encodeLiveEnvelope,
  encodeLiveFrame,
  readLiveEnvelope,
  isClientLiveFrame,
  isServerLiveFrame,
  encodeListDelta,
  applyListDelta,
} from '@velajs/live-protocol';
export type { ClientLiveFrame, LiveFrame, RowOp, ServerLiveFrame } from '@velajs/live-protocol';
