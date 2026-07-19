/**
 * @velajs/studio — the edge-safe Vela Studio admin module.
 *
 * Mounts the reserved `/_vela/admin` surface, hosts `@AdminRpc` operations, and
 * carries the token / sub-token / confirm-token security layer. M2 shipped the
 * mount + security + dispatch registry; M4 adds the app-introspection, logs/audit,
 * and capability-negotiation ops with real feature detection. Data-browser,
 * time-travel, and adapter ops land in later milestones.
 */

// Reserved base path (kept for compatibility; canonical value lives in the
// protocol's STUDIO_DEFAULT_PATH).
export const STUDIO_ADMIN_BASE_PATH = '/_vela/admin';

// Module + config
export { StudioModule, STUDIO_MODULE_OPTIONS } from './studio.module';
export { studioConfig, resolveStudioConfig } from './studio.config';
export type { StudioEnv, StudioEnvConfig } from './studio.config';

// Public types
export type {
  EditableFlags,
  StudioModuleOptions,
  ResolvedStudioConfig,
  StudioRunAsIdentity,
  AdminPrincipal,
  AdminOpContext,
  AdminAuditDetail,
  AdminRpcHandler,
  AdminRpcMeta,
  AdminConfirmSummaryMeta,
  AdminConfirmSummarizer,
  StudioConfirmChallenge,
} from './studio.types';
export { deriveWriteGates } from './studio.types';

// RPC surface
export { AdminRpc, AdminConfirmSummary } from './rpc/admin-rpc.decorator';
export { StudioDispatchRegistry } from './rpc/dispatch.registry';

// Injection tokens + metadata key
export {
  STUDIO_RESOLVED_CONFIG,
  STUDIO_TEST_ONLY_OPS,
  ADMIN_AUDIT_SINK,
  STUDIO_ADMIN_META,
} from './tokens';
export type { AdminAuditSink } from './tokens';

// Errors
export { STUDIO_CATALOG, studioError, toAdminErrorBody } from './studio.errors';

// Security primitives
export { timingSafeEqual } from './security/token-compare';
export { AdminSubTokenSigner } from './security/sub-token.signer';
export type {
  SubTokenClaims,
  MintSubTokenInput,
  AdminSubTokenSignerOptions,
} from './security/sub-token.signer';
export { ConfirmTokenSigner } from './security/confirm-token';
export type { ConfirmTokenSignerOptions } from './security/confirm-token';

// Audit + logs
export { AdminAuditLog } from './audit/audit-log';
export { AdminLogBuffer } from './logs/log-buffer';

// Features (real detection — M4)
export { StudioFeaturesService } from './features/features.service';

// Introspection collectors + the mount-time app-capture seam + the opt-in
// route-attribution adapter (M9).
export { StudioAppHolder } from './introspect/app-holder';
export { collectRoutes, collectModules, collectEntrypoints } from './introspect/collect';
export { studioRuntimeAdapter } from './introspect/runtime-adapter';

// M4 op providers (app introspection, logs/audit, capability negotiation)
export { StudioAppOps } from './ops/app.ops';
export { StudioLogsOps } from './ops/logs.ops';
export { StudioCapabilitiesOps } from './ops/studio.ops';

// M5 data browser — the READ ops + the source port (the crud binding lives in
// the optional `@velajs/studio/crud` subpath, never in this core `.` entry).
export { StudioDataOps } from './data/data.ops';
export { STUDIO_MODEL_SOURCE } from './data/model-source.port';
export type { StudioModelSource } from './data/model-source.port';

// M7a data browser — the WRITE ops provider + the write seam types. The provider
// is crud-free (authored against the port) but registered by StudioCrudModule.
export { StudioDataWriteOps, MAX_GENERATE_ROWS } from './data/data.write.ops';
export type {
  StudioWriteContext,
  StudioWriteRowOutcome,
  StudioDeleteRowsOutcome,
  StudioGenerateRowsOutcome,
} from './data/model-source.port';

// M8a portable time travel — the port token + the `timeTravel.*` ops (registered
// on core). The snapshot adapter, store seam, CDC seam, and opt-in binding module
// live in the `@velajs/studio/timetravel` subpath.
export { TIME_TRAVEL_PORT } from './timetravel/port.token';
export { StudioTimeTravelOps } from './timetravel/timetravel.ops';
export {
  SnapshotTimeTravelAdapter,
  SNAPSHOT_STORE,
  InMemorySnapshotStore,
  CHANGE_SOURCE,
  StudioTimeTravelModule,
  STUDIO_TIMETRAVEL_MODULE_OPTIONS,
  NoopLiveInvalidator,
  ContainerLiveInvalidator,
  schemaHashForColumns,
  combinedSchemaHash,
} from './timetravel';
export type {
  SnapshotStore,
  SnapshotAdapterDeps,
  ChangeSource,
  LiveInvalidatorPort,
  StudioTimeTravelModuleOptions,
} from './timetravel';

// M9 auth panel — the READ/WRITE ops + the source port (the better-auth binding
// lives in the optional `@velajs/studio/auth` subpath, never in this core `.` entry).
export { StudioAuthOps } from './auth/auth.ops';
export { STUDIO_AUTH_SOURCE } from './auth/auth.port';
export type { StudioAuthSource, StudioAuthCapabilities } from './auth/auth.port';

// M9 transfer — bulk export/import ops (over STUDIO_MODEL_SOURCE) + the NDJSON
// streaming helpers the `/export` route shares. Peer-free (crud-agnostic).
export {
  StudioTransferOps,
  streamModelNdjson,
  streamAllModelsNdjson,
} from './transfer/transfer.ops';

// HTTP
export { RateLimiter, FixedWindowCounter, DEFAULT_MAX_ENTRIES } from './http/middleware/rate-limit';
export type { RateLimitOptions, Clock } from './http/middleware/rate-limit';
export { StudioAdminController, studioRouteContributor } from './http/route-contributor';
export { mountAdminRouter } from './http/admin-router';

// Ergonomic re-export of the frozen wire contract.
export * from '@velajs/studio-protocol';
