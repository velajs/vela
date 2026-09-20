/** Schema-bound lifecycle hooks for the native CRUD kernel. */

import type { output, ZodRawShape } from 'zod';
import type { createHookSchemas } from './compile-hooks';
import type { Page } from '../adapter/query-types';

/**
 * Context handed to every hook. `db.tx` is the adapter-specific transaction
 * handle for the in-flight write — a `sequential` hook that runs inside the
 * parent transaction can participate in (and roll back) it. The remaining
 * fields are the resolved actor/tenant identity, sourced from the request's
 * context vars (undefined when their source is absent).
 */
export interface HookContext {
  /** In-flight write transaction handle (adapter-specific; `undefined` outside a tx). */
  db: { tx: unknown };
  /** The raw inbound `Request`, when a request is in scope. */
  request?: Request;
  /** Resolved tenant id (multi-tenant resolver / context var). */
  tenantId?: string;
  /** Resolved organization id. */
  organizationId?: string;
  /** Resolved acting user id. */
  userId?: string;
  /** Resolved acting agent id (agentic callers). */
  agentId?: string;
  /** Resolved agent-run id (agentic callers). */
  agentRunId?: string;
}

/**
 * How a group of same-phase hooks is executed:
 *   - `sequential` — awaited one at a time, in order; a throw aborts and
 *     propagates (rolls back the parent tx for in-transaction hooks). Only
 *     this mode threads before-hook return values into the next hook.
 *   - `parallel` — all started at once and awaited via `Promise.all`; the
 *     first rejection aborts. Before-hook return values are IGNORED.
 *   - `fire-and-forget` — invoked without awaiting; rejections are swallowed
 *     (and `console.warn`-ed) so they can never fail or roll back the request.
 */
export type HookMode = 'sequential' | 'parallel' | 'fire-and-forget';

/** Per-verb hook-mode override (before- and after-phase run independently). */
export interface HookModeConfig {
  /** Execution mode for the verb's before-hooks. @default 'sequential' */
  beforeMode?: HookMode;
  /** Execution mode for the verb's after-hooks. @default 'sequential' */
  afterMode?: HookMode;
}

/**
 * A hook that may replace the value it receives. Returning a value substitutes
 * it (for the next hook, in sequential before-chains, or for the write/response
 * payload). Returning `void`/`undefined` keeps the supplied value, including
 * validated in-place mutations. Both sync and async are accepted.
 */
type Mutator<In, Out = In> = (ctx: HookContext, value: In) => Out | void | Promise<Out | void>;

/**
 * Lifecycle hooks for one CRUD resource. Every field is optional; a resource
 * wires only the hooks it needs. Arrays are NOT used here — this is the
 * declarative per-resource surface; the kernel collects the configured hooks
 * (model-level + route-level) into the arrays it hands to `runHooks` /
 * `runBeforeChain`.
 *
 * @typeParam T - the validated persisted row type.
 * @typeParam Write - a validated partial write; generated fields may be absent.
 * @typeParam Shaped - a partial row after field masking or projection.
 */
export interface CrudHooks<T = unknown, Write = Partial<T>, Shaped = Partial<T>> {
  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------
  /**
   * Before an INSERT. Receives the validated, tenant-injected create payload;
   * may return a replacement payload (the returned object is persisted).
   * Parity: hono-crud `CreateHooks.before(data, ctx)`, ctx moved to front.
   */
  beforeCreate?: Mutator<Write>;
  /**
   * After an INSERT. Receives the persisted row; may return a replacement used
   * for the response. Parity: hono-crud `CreateHooks.after(data, ctx)`.
   */
  afterCreate?: Mutator<T>;

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------
  /**
   * Before an UPDATE. Receives the (field-filtered) patch AND the pre-mutation
   * `prior` snapshot; may return a replacement patch.
   *
   * DIVERGENCE: hono-crud's `UpdateHooks.before` received only `(patch, ctx)` —
   * the native surface additionally threads `prior` so a before-hook can diff
   * against the current row without a re-fetch. The old bridge's
   * `beforeUpdate(ctx, data)` also lacked `prior`; existing 2-arg callers stay
   * valid (the extra parameter is ignored by hooks that don't declare it).
   */
  beforeUpdate?: (ctx: HookContext, patch: Write, prior: T) => Write | void | Promise<Write | void>;
  /**
   * After an UPDATE. Receives the pre-mutation `prior` AND post-mutation
   * `current` snapshots (both observed inside the parent transaction), so
   * diff-based audit/CDC pipelines need no re-fetch. Parity: hono-crud
   * `UpdateHooks.after(prior, current, ctx)` (0.10.0 two-snapshot shape),
   * ctx-first — identical arity to the old bridge's `afterUpdate`.
   */
  afterUpdate?: (ctx: HookContext, prior: T, current: T) => T | void | Promise<T | void>;

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------
  /**
   * Before a DELETE. Receives the pre-mutation `prior` row.
   *
   * DIVERGENCE: hono-crud's `DeleteHooks.before` and the old bridge's
   * `beforeDelete` both received the raw lookup-value string. The native
   * surface passes the resolved `prior` row instead — symmetric with
   * {@link afterDelete} and far more useful (the hook can inspect the row it is
   * about to remove without a separate read). Tracked parity blind spot for
   * callers that relied on the string id.
   */
  beforeDelete?: (ctx: HookContext, prior: T) => void | Promise<void>;
  /**
   * After a DELETE. Receives the pre-mutation `prior` row (for soft-delete, the
   * row before its delete marker was stamped). Parity: hono-crud
   * `DeleteHooks.after(prior, ctx)` — identical arity to the old bridge.
   */
  afterDelete?: (ctx: HookContext, prior: T) => void | Promise<void>;

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------
  /** Before a LIST query is issued. Observe-only (no payload). */
  beforeList?: (ctx: HookContext) => void | Promise<void>;
  /**
   * After a LIST resolves. Receives the whole {@link Page} (rows +
   * `result_info`); may return a replacement page.
   *
   * DIVERGENCE: hono-crud's `ListHooks.after` (and the old bridge's
   * `afterList`) received the bare items array. The native surface passes the
   * full `Page<unknown>` because per-row transforms may return arbitrary values.
   * Per-row shaping belongs in {@link transformList}.
   */
  afterList?: (
    ctx: HookContext,
    page: Page<unknown>,
  ) => Page<unknown> | void | Promise<Page<unknown> | void>;
  /**
   * Per-row output transform for LIST. Runs once per row after masking and before `afterList`.
   * Parity: hono-crud `ListHooks.transform(item)` — ctx-first here (the old
   * bridge had no list transform).
   */
  transformList?: (ctx: HookContext, item: Shaped) => unknown | Promise<unknown>;

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------
  /**
   * Before a point READ. Receives the lookup value (path param). Observe-only.
   * Parity: the old bridge's `beforeRead(ctx, lookupValue)` (hono-crud's Read
   * endpoint had no `before` hook).
   */
  beforeRead?: (ctx: HookContext, lookupValue: string) => void | Promise<void>;
  /**
   * After a point READ resolves. Receives the row; may return a replacement.
   * Parity: hono-crud `ReadHooks.after(data)` / old bridge `afterRead`.
   */
  afterRead?: Mutator<T>;
  /**
   * Per-row output transform for READ. Parity: hono-crud
   * `ReadHooks.transform(item)` — ctx-first (the old bridge lacked it).
   */
  transformRead?: (ctx: HookContext, item: Shaped) => unknown | Promise<unknown>;

  // -------------------------------------------------------------------------
  // upsert
  // -------------------------------------------------------------------------
  /**
   * Before an UPSERT. Receives the payload plus `isCreate` — whether this
   * upsert will INSERT (`true`) rather than UPDATE. May return a replacement
   * payload. Parity: hono-crud `UpsertHooks.before(data, isCreate)`, ctx-first.
   * (The old bridge had no upsert hooks — a pure extension.)
   */
  beforeUpsert?: (
    ctx: HookContext,
    data: Write,
    isCreate: boolean,
  ) => Write | void | Promise<Write | void>;
  /**
   * After an UPSERT. Receives the persisted row plus `created` — whether a row
   * was INSERTED (`true`) rather than UPDATED. May return a replacement.
   * Parity: hono-crud `UpsertHooks.after(data, created)`, ctx-first.
   */
  afterUpsert?: (ctx: HookContext, record: T, created: boolean) => T | void | Promise<T | void>;

  // -------------------------------------------------------------------------
  // batch* — run once PER ITEM with the item's 0-based index
  //
  // Parity: hono-crud's batch endpoints run before/after per item; the native
  // surface normalises all of them to `(ctx, item, index)`.
  // DIVERGENCE: hono-crud's batch-upsert before/after operated on the WHOLE
  // batch — the native surface makes them per-item like the other batch verbs.
  // -------------------------------------------------------------------------
  /** Before each item of a batch INSERT. May return a replacement item. */
  beforeBatchCreate?: BatchMutator<Write>;
  /** After each item of a batch INSERT. May return a replacement row. */
  afterBatchCreate?: BatchMutator<T>;
  /** Before each item of a batch UPDATE. May return a replacement patch. */
  beforeBatchUpdate?: BatchMutator<Write>;
  /** After each item of a batch UPDATE. May return a replacement row. */
  afterBatchUpdate?: BatchMutator<T>;
  /** Before each item of a batch DELETE. Receives the pre-mutation row. */
  beforeBatchDelete?: (ctx: HookContext, prior: T, index: number) => void | Promise<void>;
  /** After each item of a batch DELETE. Receives the pre-mutation row. */
  afterBatchDelete?: (ctx: HookContext, prior: T, index: number) => void | Promise<void>;
  /** Before each item of a batch RESTORE. Receives the soft-deleted row. */
  beforeBatchRestore?: (ctx: HookContext, prior: T, index: number) => void | Promise<void>;
  /** After each item of a batch RESTORE. May return a replacement row. */
  afterBatchRestore?: BatchMutator<T>;
  /** Before each item of a batch UPSERT. May return a replacement item. */
  beforeBatchUpsert?: BatchMutator<Write>;
  /** After each item of a batch UPSERT. May return a replacement row. */
  afterBatchUpsert?: BatchMutator<T>;

  // -------------------------------------------------------------------------
  // per-verb hook-mode config
  // -------------------------------------------------------------------------
  /**
   * Per-verb execution-mode overrides. A verb absent from this map uses the
   * default (`sequential` for both phases). Applies to the verbs that run
   * mutating before/after hooks; read-path verbs (list/read) run their after
   * hooks sequentially and are not configurable here.
   */
  modes?: {
    create?: HookModeConfig;
    update?: HookModeConfig;
    delete?: HookModeConfig;
    upsert?: HookModeConfig;
    batchCreate?: HookModeConfig;
    batchUpdate?: HookModeConfig;
    batchDelete?: HookModeConfig;
    batchRestore?: HookModeConfig;
    batchUpsert?: HookModeConfig;
  };
}

/**
 * A per-item batch hook: receives the item and its 0-based `index`, may return
 * a replacement item. `void`/`undefined` keeps validated in-place mutations.
 */
export type BatchMutator<V> = (
  ctx: HookContext,
  item: V,
  index: number,
) => V | void | Promise<V | void>;

/** Persisted records, including relation/computed fields not declared in the schema. */
export type SchemaRow<Shape extends ZodRawShape> = output<
  ReturnType<typeof createHookSchemas<Shape>>['persisted']
>;

/** The actual output of Zod's partial passthrough parser; no generic cast is needed. */
export type SchemaWrite<Shape extends ZodRawShape> = output<
  ReturnType<typeof createHookSchemas<Shape>>['partial']
>;

/** Fields removed by policies or serialization profiles are genuinely optional. */
export type SchemaShaped<Shape extends ZodRawShape> = SchemaWrite<Shape>;

/** Author-facing hooks retain their schema-derived types until compilation. */
export type SchemaHooks<Shape extends ZodRawShape> = CrudHooks<
  SchemaRow<Shape>,
  SchemaWrite<Shape>,
  SchemaShaped<Shape>
> &
  HookModeConfig;
