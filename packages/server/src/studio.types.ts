/**
 * Server-side Studio types: module options, resolved config, the per-op
 * dispatch context, and the `@AdminRpc` meta. Wire shapes are never redeclared
 * here — they come from `@velajs/studio-protocol`.
 */
import type { Context } from 'hono';
import type { Token, Type } from '@velajs/vela';
import type { StudioOp, StudioWriteGates } from '@velajs/studio-protocol';
import type { AdminAuditEntry } from '@velajs/studio-protocol';

/**
 * The six server-side editable categories. The wire-facing
 * {@link StudioWriteGates} are DERIVED one-to-one from these (see
 * `deriveWriteGates`). Each category gates a distinct class of destructive
 * capability — none is a proxy for another — so an operator can, e.g., enable
 * time-travel restore without also unlocking bulk transfer import.
 *
 * This is SERVER-SIDE config, not a frozen wire shape; the wire
 * {@link StudioWriteGates} in `@velajs/studio-protocol` is the frozen contract.
 */
export interface EditableFlags {
  /** Data-row create/update/delete/generate. */
  data: boolean;
  /** Schema-level edits. */
  schema: boolean;
  /** Run-as / identity-scoped reads and writes. */
  identity: boolean;
  /** Operational actions (queue send/replay, schedule run-now, session revoke, api.tryit). */
  ops: boolean;
  /** Time-travel restore / undo / prune. */
  timeTravel: boolean;
  /** Transfer import (bulk NDJSON ingest). */
  transfer: boolean;
}

/** Options accepted by `StudioModule.forRoot` (override env). */
export interface StudioModuleOptions {
  /** Force-disable even when a token is present. Default: enabled iff a token is configured. */
  enabled?: boolean;
  /** Reserved base path. Default `/_vela/admin`. */
  path?: string;
  /** Mount at `path` verbatim (ignore the app's global prefix). Default false. */
  absolute?: boolean;
  /** Master bearer token. When absent (and none in env), Studio is default-closed. */
  token?: string;
  /**
   * The app's ROOT module. Required for `app.openapi` (and the `openapi`
   * capability): Studio is mounted as an imported module and cannot otherwise
   * discover the graph to hand `createOpenApiDocument`. Absent ⇒ the op reports
   * `FEATURE_UNCONFIGURED` and the `openapi` feature stays dark.
   */
  rootModule?: Type;
  /** Editable-category overrides (each defaults to its env value, else false). */
  editable?: Partial<EditableFlags>;
  /**
   * Restrict which discovered crud models the data browser manages. `include`
   * is an allow-list (only these surface); `exclude` is a deny-list. Each entry
   * matches a model by its name OR its table name. Absent ⇒ every discovered
   * model is managed.
   */
  managedModels?: { include?: string[]; exclude?: string[] };
  /** Audit ring-buffer capacity. Default 500. */
  auditBufferSize?: number;
  /** Log ring-buffer capacity. Default 1000. */
  logBufferSize?: number;
  /** Per-IP rate limit, or `false` to disable. Default `{ windowMs: 60000, max: 120 }`. */
  rateLimit?: { windowMs: number; max: number } | false;
  /** WS sub-token lifetime in seconds. Default 300. */
  subTokenTtlSec?: number;
}

/** Fully-resolved config (env merged under options), the shape providers inject. */
export interface ResolvedStudioConfig {
  enabled: boolean;
  path: string;
  absolute: boolean;
  token?: string;
  /** The app's root module for OpenAPI generation (see {@link StudioModuleOptions.rootModule}). */
  rootModule?: Type;
  editable: EditableFlags;
  /** Data-browser model allow/deny filter (see {@link StudioModuleOptions.managedModels}). */
  managedModels?: { include?: string[]; exclude?: string[] };
  rateLimit: { windowMs: number; max: number } | false;
  subTokenTtlSec: number;
  auditBufferSize: number;
  logBufferSize: number;
}

/** The authenticated admin caller. M2 authenticates the master bearer only. */
export interface AdminPrincipal {
  /** Audit subject (M2: `'master'`). */
  subject: string;
  /** Authentication mechanism. */
  via: 'master-token';
  /** Best-effort client IP (from the trust-boundary header), or null. */
  ip: string | null;
}

/** Detail a handler may attach to its audit row. */
export type AdminAuditDetail = NonNullable<AdminAuditEntry['detail']>;

/**
 * Context handed to an `@AdminRpc` handler. `args` arrive as the handler's
 * second parameter (typed per op); this context carries the ambient request
 * surface: raw HTTP, the principal, the resolved editable gates, an audit sink,
 * and a DI accessor.
 */
export interface AdminOpContext {
  /** The raw Hono request context. */
  http: Context;
  /** The authenticated caller. */
  admin: AdminPrincipal;
  /** Resolved editable gates for this app. */
  editable: EditableFlags;
  /** Attach detail to this op's audit row (best-effort). */
  audit(detail: AdminAuditDetail): void;
  /** Resolve a provider from the app container. */
  get<T>(token: Token<T>): T;
}

/** An `@AdminRpc` handler: receives the op context and the op's typed args. */
export type AdminRpcHandler = (ctx: AdminOpContext, args: unknown) => unknown | Promise<unknown>;

/**
 * Metadata carried by `@AdminRpc`. `op` is the ONLY classification stored here;
 * mode / feature / gate / destructive are read from `STUDIO_OP_META[op]` so
 * there is exactly one source of truth. `op` is widened with `string` so the
 * test-only escape (fake ops allowed via `STUDIO_TEST_ONLY_OPS`) type-checks
 * without casts, while real ops keep their literal autocomplete.
 */
export interface AdminRpcMeta {
  op: StudioOp | (string & {});
  summary?: string;
}

/**
 * Derive the six wire-facing write gates from the six editable categories.
 * Every mapping is one-to-one — no category grants a gate it does not name — so
 * enabling one capability never silently unlocks another. Documented here as
 * the single derivation.
 */
export function deriveWriteGates(editable: EditableFlags): StudioWriteGates {
  return {
    dataEditable: editable.data,
    schemaEditable: editable.schema,
    opsEditable: editable.ops,
    runAsIdentity: editable.identity,
    timeTravelRestore: editable.timeTravel,
    transferImport: editable.transfer,
  };
}
