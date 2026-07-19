/**
 * @velajs/studio — the edge-safe Vela Studio admin module.
 *
 * Mounts the reserved `/_vela/admin` surface, hosts `@AdminRpc` operations, and
 * carries the token / sub-token / confirm-token security layer. Feature ops land
 * in later milestones; M2 ships the mount + security + dispatch registry.
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
  AdminPrincipal,
  AdminOpContext,
  AdminAuditDetail,
  AdminRpcHandler,
  AdminRpcMeta,
} from './studio.types';
export { deriveWriteGates } from './studio.types';

// RPC surface
export { AdminRpc } from './rpc/admin-rpc.decorator';
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

// Features (M2 stub; detection lands in M4)
export { StudioFeaturesService } from './features/features.service';

// HTTP
export { RateLimiter, FixedWindowCounter, DEFAULT_MAX_ENTRIES } from './http/middleware/rate-limit';
export type { RateLimitOptions, Clock } from './http/middleware/rate-limit';
export { StudioAdminController, studioRouteContributor } from './http/route-contributor';
export { mountAdminRouter } from './http/admin-router';

// Ergonomic re-export of the frozen wire contract.
export * from '@velajs/studio-protocol';
