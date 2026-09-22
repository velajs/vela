/**
 * The adapter contract: ONE plain-object interface with five required core
 * methods, optional capability methods, and a declared capability set.
 *
 * This replaces hono-crud's 22-slot `AdapterBundle` of abstract endpoint
 * classes. Vela owns HTTP entirely, so an adapter is pure data access —
 * no context, no validation, no serialization. Extended verbs the adapter
 * doesn't implement natively are synthesized by the engine from the core
 * five (restore = update, clone = read+create, batch = loops, ...), always
 * inside `transaction()` when atomicity is required.
 */

import type {
  AggregateResult,
  AggregateSpec,
  BulkOutcome,
  DeleteOptions,
  FilterCondition,
  ListQuery,
  Lookup,
  Page,
  ReadOptions,
  SearchHit,
  SearchQuery,
  UpsertInput,
} from './query-types';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Data-plane capabilities an adapter can declare. Presence of an optional
 * method MUST match the declared set — `assertAdapterSatisfies` cross-checks
 * both at resource-definition time so a configured feature without adapter
 * support fails loudly, never silently (hono-crud `requireAdapter` parity).
 */
export const ADAPTER_CAPABILITIES = [
  'structuredPredicates',
  'nestedPredicates',
  'scopedUpsert',
  /** Real transactional scope (memory adapters use a no-op sentinel instead). */
  'transactions',
  /** Core update/delete return rows from the same atomic SQL statement. */
  'atomicMutations',
  /** Precomputed commands commit or roll back together; distinct from callbacks. */
  'atomicBatch',
  /** `id: 'database'` — the database generates primary keys (RETURNING/serial). */
  'databaseGeneratedId',
  /** Keyset (cursor) pagination in `list`. Never emulated: absent = loud error. */
  'cursor',
  /** Native aggregate queries. */
  'aggregate',
  /** Native full-text search (otherwise the engine's scoring fallback runs). */
  'nativeSearch',
  /** Native insert-or-update by conflict target. */
  'upsert',
  /** Native filtered bulk patch (`updateWhere`). */
  'bulkPatch',
  /** Native multi-row insert (`createMany`). */
  'nativeBatch',
  /** Nested relation writes (create/update/delete/connect/disconnect/set). */
  'nestedWrites',
  /** Cascade handling on delete (cascade/setNull/restrict). */
  'cascade',
  /** Soft-delete stamping in `delete` + soft-delete-aware reads. */
  'softDelete',
  /**
   * Native un-delete of a soft-deleted row (clears the soft-delete field).
   * Restore CANNOT be synthesized from the core five: `update` is contractually
   * blind to soft-deleted rows (a regular update of a deleted row 404s), so the
   * engine has no core primitive that can flip the marker back — an adapter that
   * soft-deletes must provide `restore` for the restore verb (and for upsert's
   * match-and-restore of a soft-deleted row) to work.
   */
  'restore',
  /**
   * The adapter enforces the model's `unique` tuples — natively (memory
   * scans) or via database constraints translated to 409 ConflictException
   * (SQL drivers). Member-less: enforcement is behavioral on the write
   * methods, not a dedicated method.
   */
  'uniqueConstraints',
] as const;

export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Transaction scope
// ---------------------------------------------------------------------------

/**
 * Opaque per-operation handle owned by the adapter. The engine threads it
 * into every data call and into `HookContext.db.tx`, so two-snapshot hooks
 * observe pre-mutation state inside the same transaction as the write.
 */
export interface AdapterScope {
  readonly tx: unknown;
}

/**
 * Request context handed to `transaction()` at tx open — NOT part of
 * `AdapterScope` (which stays the opaque per-op tx handle). SQL adapters can
 * use it for per-transaction session state, e.g. a Postgres RLS GUC
 * (`SET LOCAL app.tenant_id`). Adapters that ignore it stay valid.
 */
export interface TransactionContext {
  readonly tenantId?: string;
}

// ---------------------------------------------------------------------------
// Optional drivers
// ---------------------------------------------------------------------------

/** Nested relation-write operations (hono-crud `nested-writes.ts` semantics). */
export interface NestedWriteDriver<Row = Record<string, unknown>> {
  /**
   * Resolve every existing row an operation can mutate, inside the same
   * adapter scope that will later apply the mutation. Arrays for selector
   * based operations MUST be positionally aligned with the corresponding
   * operation array; a missing or out-of-scope target is represented by
   * `null`. `setDisconnect` is deliberately unscoped: it contains every row
   * currently related to the parent, including a row outside `targetScope`,
   * so the engine can detect corrupt/cross-tenant relations and fail closed.
   */
  inspectNestedTargets(
    parent: Row,
    relation: string,
    operations: NestedWriteOperations,
    scope: AdapterScope,
  ): Promise<NestedWriteInspection>;
  /** Create related records referenced by a parent create/update payload. */
  createNested(
    parent: Row,
    relation: string,
    records: Array<Record<string, unknown>>,
    scope: AdapterScope,
  ): Promise<void>;
  /** Apply update/delete/connect/disconnect/set operations for one relation. */
  applyNested(
    parent: Row,
    relation: string,
    operations: NestedWriteOperations,
    scope: AdapterScope,
  ): Promise<void>;
}

export interface NestedWriteOperations {
  /** Authorization ANDed into inspection and every existing-row mutation. */
  targetPredicate?: import('../query/predicate').QueryPredicate;
  /** Server-derived target-row scope (tenant isolation) ANDed into every nested match. */
  targetScope?: Record<string, unknown>;
  create?: Array<Record<string, unknown>>;
  update?: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  delete?: Array<Record<string, unknown>>;
  connect?: Array<Record<string, unknown>>;
  disconnect?: Array<Record<string, unknown>>;
  set?: Array<Record<string, unknown>>;
}

/** Rows resolved by {@link NestedWriteDriver.inspectNestedTargets}. */
export interface NestedWriteInspection<Row = Record<string, unknown>> {
  update: Array<Row | null>;
  delete: Array<Row | null>;
  connect: Array<Row | null>;
  disconnect: Array<Row | null>;
  setConnect: Array<Row | null>;
  setDisconnect: Row[];
}

/** Cascade-on-delete operations (hono-crud `endpoints/delete.ts` semantics). */
export interface CascadeDriver {
  countRelated(relation: string, parentKey: unknown, scope: AdapterScope): Promise<number>;
  deleteRelated(relation: string, parentKey: unknown, scope: AdapterScope): Promise<number>;
  nullifyRelated(relation: string, parentKey: unknown, scope: AdapterScope): Promise<number>;
}

/**
 * Owner-scope applied while fetching related rows (parity with the SQL
 * adapters' WHERE push-down): a related row in another tenant or a
 * soft-deleted one is skipped at fetch time, not just re-filtered upstream.
 */
export interface RelationLoadScope {
  predicate?: import('../query/predicate').QueryPredicate;
  tenantField?: string;
  tenantValue?: string;
  /** Related rows with a non-null value in this field are excluded. */
  excludeDeletedField?: string;
}

/**
 * Batch relation loader backing `?include=` (hono-crud
 * `relations/batch-loader.ts` parity — one query per relation, never N+1).
 * Returns related rows grouped by their join value; the engine attaches them
 * to parents (hasMany → array, hasOne/belongsTo → first match).
 */
export interface RelationLoader<Row = Record<string, unknown>> {
  load(
    rows: Row[],
    relation: string,
    loadScope: RelationLoadScope,
    scope: AdapterScope,
  ): Promise<Map<unknown, Array<Record<string, unknown>>>>;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface CrudAdapter<Row = Record<string, unknown>> {
  /** Identity of the database/store that owns scopes. Share only when native
   * scopes are mutually usable; names and engine kinds are not identities. */
  readonly transactionOwner?: object;
  /** Explicit dynamic engine view. Typed facades never erase their input types. */
  readonly runtime: RuntimeAdapter;

  /**
   * Declared capability set. Must agree with which optional members exist —
   * declaring a capability without its method (or vice versa) is a
   * configuration error surfaced at resource-definition time.
   */
  readonly capabilities: ReadonlySet<AdapterCapability>;

  atomicBatch?: import('./atomic').AtomicBatchDriver<Row>;

  /** Ordinary request scope; no rollback guarantee. RLS adapters may open a real
   * transaction here to keep transaction-local tenant settings on reads. */
  requestScope<T>(fn: (scope: AdapterScope) => Promise<T>, ctx?: TransactionContext): Promise<T>;

  /** Callback transaction. SQL adapters declaring `transactions` roll back on
   * rejection. D1 rejects without invoking the callback. Memory retains its
   * explicitly non-atomic prototype scope and does not declare transactions.
   * Both scope methods receive the request's trusted tenant context. */
  transaction<T>(fn: (scope: AdapterScope) => Promise<T>, ctx?: TransactionContext): Promise<T>;

  // -- Required core (everything else can be synthesized from these) --------

  create(input: Partial<Row>, scope: AdapterScope): Promise<Row>;
  readOne(lookup: Lookup, opts: ReadOptions, scope: AdapterScope): Promise<Row | null>;
  /** Partial update; returns the post-mutation row, or null when not found. */
  update(lookup: Lookup, patch: Partial<Row>, scope: AdapterScope): Promise<Row | null>;
  /** Hard delete, or soft-delete stamp when `opts.softDeleteField` is set. */
  delete(lookup: Lookup, opts: DeleteOptions, scope: AdapterScope): Promise<Row | null>;
  list(query: ListQuery, scope: AdapterScope): Promise<Page<Row>>;

  // -- Optional capability methods (presence must match `capabilities`) -----

  aggregate?(spec: AggregateSpec, scope: AdapterScope): Promise<AggregateResult>;
  search?(spec: SearchQuery, scope: AdapterScope): Promise<Array<SearchHit<Row>>>;
  /**
   * Insert-or-update on the conflict target. On the UPDATE (conflict) leg,
   * adapters must NOT rewrite primary-key columns from `input` — the PK is
   * insert-time identity only (relevant under `id: 'client'`, where the
   * create-derived body carries a caller PK).
   */
  upsertOne?(input: UpsertInput<Row>, scope: AdapterScope): Promise<{ row: Row; created: boolean }>;
  /**
   * Un-delete a soft-deleted row: find it INCLUDING soft-deleted rows (honoring
   * `lookup.filters` for tenant/ownership scope), clear the soft-delete field,
   * and return the restored row. Returns `null` when the row is missing OR is
   * not currently soft-deleted (nothing to restore) — the engine maps that to a
   * 404 (MemoryRestoreEndpoint parity). Present iff `capabilities` has
   * `'restore'`.
   */
  restore?(lookup: Lookup, scope: AdapterScope): Promise<Row | null>;
  updateWhere?(
    filters: FilterCondition[],
    patch: Partial<Row>,
    scope: AdapterScope,
  ): Promise<BulkOutcome<Row>>;
  createMany?(rows: Array<Partial<Row>>, scope: AdapterScope): Promise<Row[]>;

  nested?: NestedWriteDriver<Row>;
  cascade?: CascadeDriver;
  relations?: RelationLoader<Row>;
}

/** Maps each capability to the optional member whose presence it implies. */
export const CAPABILITY_MEMBERS: Partial<Record<AdapterCapability, keyof RuntimeAdapter>> = {
  atomicBatch: 'atomicBatch',
  aggregate: 'aggregate',
  nativeSearch: 'search',
  upsert: 'upsertOne',
  restore: 'restore',
  bulkPatch: 'updateWhere',
  nativeBatch: 'createMany',
  nestedWrites: 'nested',
  cascade: 'cascade',
};

/** Adapter data plane used after the engine validates request schemas. */
export type RuntimeAdapter = Omit<CrudAdapter<Record<string, unknown>>, 'runtime'>;

/** Package a custom dynamic adapter without claiming a narrower row schema. */
export function bindAdapter(runtime: RuntimeAdapter): CrudAdapter {
  return Object.assign(runtime, { runtime });
}
