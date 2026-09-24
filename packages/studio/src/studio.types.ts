/**
 * Server-side Studio types: module options, resolved config, the per-op
 * dispatch context, and the `@AdminRpc` meta. Wire shapes are never redeclared
 * here — they come from `@velajs/studio-protocol`.
 */
import type { Context } from 'hono';
import type { DynamicModule, Token, Type } from '@velajs/vela';
import type { InferToken } from '@velajs/vela/module-kit';
import type { StudioPlugin } from './plugin';
import type { StudioConfirmChallenge, StudioOp, StudioWriteGates } from '@velajs/studio-protocol';
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
  /** Operational actions (queue send/replay, schedule run-now, session revoke, api.authorizeTryIt). */
  ops: boolean;
  /** Time-travel restore / undo / prune. */
  timeTravel: boolean;
  /** Transfer import (bulk NDJSON ingest). */
  transfer: boolean;
}

/**
 * Server-only impersonation identity for write dispatches. A STRUCTURAL MIRROR
 * of `@velajs/crud`'s kernel `EngineRequestVars` (mirrored, never imported — the
 * core `.` entry stays crud-free per the optional-peer discipline). A
 * kernel-backed source would thread this straight into `EngineRequest.vars` so
 * policies/multi-tenant evaluate as the impersonated actor; the current
 * adapter-direct source records only the resolved subject in the audit and does
 * NOT policy-scope (see the M7a report's investigation table). Either way the
 * value is configuration — it NEVER crosses the wire.
 */
export interface StudioRunAsIdentity {
  user?: unknown;
  tenantId?: string;
  organizationId?: string;
  userId?: string;
  agentId?: string;
  agentRunId?: string;
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
   * The module `app.openapi` documents. Defaults to the application's root
   * (`ROOT_MODULE`, the class or `DynamicModule` the application was created
   * from); pass a narrower module to document only part of the graph.
   */
  rootModule?: Type | DynamicModule;
  /** Editable-category overrides (each defaults to its env value, else false). */
  editable?: Partial<EditableFlags>;
  /**
   * The panels this Studio serves, such as `queuesPanel()` from
   * `@velajs/studio/queue` or `crudPanel()` from `@velajs/studio/crud`. Each
   * registers its providers in this module's scope. Structural.
   */
  plugins?: readonly StudioPlugin[];
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
  /** The module OpenAPI generation documents (see {@link StudioModuleOptions.rootModule}). */
  rootModule?: Type | DynamicModule;
  editable: EditableFlags;
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
  /** Resolve synchronously from this invocation and the handler's owning module. */
  get<K extends Token>(token: K): InferToken<K>;
}

/** An `@AdminRpc` handler: receives the op context and the op's typed args. */
export type AdminRpcHandler = (ctx: AdminOpContext, args: unknown) => unknown | Promise<unknown>;

/**
 * Metadata carried by `@AdminConfirmSummary`. Names the destructive `op` whose
 * 428 challenge this method summarizes. The method — `(ctx, args) => string` —
 * supplies the human `summary` the registry embeds in the challenge details
 * (e.g. "hard-delete 3 rows from users"); it must derive purely from the args,
 * as it runs on the pre-handler challenge path.
 */
export interface AdminConfirmSummaryMeta {
  op: StudioOp | (string & {});
}

/** An `@AdminConfirmSummary` provider: turns an op's args into a human confirm line. */
export type AdminConfirmSummarizer = (
  ctx: AdminOpContext,
  args: unknown,
) => string | Promise<string>;

/**
 * The `error.details` payload of a 428 `STUDIO_CONFIRM_REQUIRED` challenge.
 *
 * FOLD-IN (M9): this is the FROZEN protocol {@link StudioConfirmChallenge}
 * (`@velajs/studio-protocol`), re-exported here so the server keeps a single
 * import site. It was previously re-declared locally (identical shape, both
 * epoch-ms) — the protocol type is now the sole source, so producer (the 428
 * emit site in `dispatch.registry`) and consumer (UI decode) cannot drift.
 */
export type { StudioConfirmChallenge };

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
