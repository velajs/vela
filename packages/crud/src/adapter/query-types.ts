import type { QueryPredicate } from '../query/predicate';
/**
 * Query-side contracts shared by the engine and every adapter.
 *
 * Behavior parity notes reference hono-crud 0.13 (the previous engine): the
 * shapes here preserve its cross-adapter contracts — fail-closed filter
 * operators, literal-needle like/ilike, Stripe-style next-only cursors —
 * while renaming the seams for the native Vela engine.
 */

// ---------------------------------------------------------------------------
// Filter operators
// ---------------------------------------------------------------------------

/**
 * Single source of truth for filter operators: the `FilterOperator` union and
 * the runtime guard `isFilterOperator` both derive from this `as const` array,
 * so the compile-time type and runtime membership check can never drift.
 */
export const FILTER_OPERATORS = [
  'eq', // equals
  'ne', // not equals
  'gt', // greater than
  'gte', // greater than or equal
  'lt', // less than
  'lte', // less than or equal
  'in', // in array
  'nin', // not in array
  // Cross-adapter substring-match contract (memory/drizzle must not diverge):
  // the user value is a LITERAL needle — `%` is stripped, `_` is inert, never
  // live SQL wildcards. `like` = substring match whose case behavior follows
  // the database collation in SQL adapters (strict in memory); `ilike` =
  // always case-insensitive substring match.
  'like',
  'ilike',
  'null', // is null (value coerced to boolean)
  'between', // between two values (comma-separated pair)
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterOperatorList = readonly FilterOperator[];

/**
 * Runtime guard for operators parsed from untrusted query strings
 * (`field[op]=value`) — an unrecognized operator must fail closed instead of
 * silently disabling a filter and returning every row.
 */
export function isFilterOperator(value: string): value is FilterOperator {
  return (FILTER_OPERATORS as readonly string[]).includes(value);
}

/** Per-field operator allow-list (`{ role: ['eq', 'in'] }`). */
export type FilterConfig = {
  [field: string]: FilterOperatorList;
};

/** A parsed filter condition, post allow-list validation. */
export interface FieldFilterCondition {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

export type FilterCondition =
  | FieldFilterCondition
  | { field: ''; operator: 'predicate'; value: QueryPredicate };

/**
 * Compile-time exhaustiveness guard for closed unions: call from a `default`
 * branch; adding a union member turns silent fall-through into a build error.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Sort / search / aggregate constants
// ---------------------------------------------------------------------------

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** A field + direction sort specification. */
export interface SortSpec {
  field: string;
  order: SortDirection;
}

/** Search modes: `any` (OR), `all` (AND), `phrase` (exact). */
export const SEARCH_MODES = ['any', 'all', 'phrase'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const AGGREGATE_OPERATIONS = ['count', 'sum', 'avg', 'min', 'max', 'countDistinct'] as const;
export type AggregateOperation = (typeof AGGREGATE_OPERATIONS)[number];

// ---------------------------------------------------------------------------
// List queries and pages
// ---------------------------------------------------------------------------

export type CursorValue = string | number | boolean | null | Date;

/** Engine-validated keyset order, including every primary key as a tie-breaker. */
export interface Keyset {
  fields: string[];
  direction: SortDirection;
  after?: CursorValue[];
}

/** Options accompanying a list query (parity: hono-crud `ListOptions`). */
export interface ListOptions {
  page?: number;
  per_page?: number;
  order_by?: string;
  order_by_direction?: SortDirection;
  search?: string;
  /** Include soft-deleted records in results. */
  withDeleted?: boolean;
  /** Show only soft-deleted records. */
  onlyDeleted?: boolean;
  /** Relations to include in the response (allow-listed upstream). */
  include?: string[];
  /** Fields to include in the response (field selection). */
  fields?: string[];
  /** Opaque cursor for keyset pagination. */
  cursor?: string;
  /** Decoded at the engine boundary; adapters never parse client cursors. */
  keyset?: Keyset;
  /** Maximum items to return (cursor pagination). */
  limit?: number;
  /**
   * Fields the inline `?search=` needle applies to. Injected by the engine
   * from the resource config so adapters stay configuration-free.
   */
  searchFields?: string[];
}

/**
 * The fully parsed, validated list query handed to `CrudAdapter.list`.
 * Filters are already allow-listed and operator-validated; tenant scoping and
 * policy pushdown conditions are merged into `filters` before the adapter
 * sees them.
 */
export interface ListQuery {
  filters: FilterCondition[];
  options: ListOptions;
}

/** Pagination metadata (parity: hono-crud `PaginatedResult.result_info`). */
export interface PageInfo {
  page: number;
  per_page: number;
  total_count?: number;
  total_pages?: number;
  has_next_page: boolean;
  has_prev_page: boolean;
  /** Next-page cursor (keyset pagination). Walks are next-only; no prev_cursor. */
  next_cursor?: string;
}

/** A page of rows plus its pagination metadata. */
export interface Page<T> {
  result: T[];
  result_info: PageInfo;
}

// ---------------------------------------------------------------------------
// Point operations
// ---------------------------------------------------------------------------

/**
 * Identifies a single record for read/update/delete/restore. Replaces
 * hono-crud's positional `(lookupValue, additionalFilters?)` pair. Tenant
 * scoping arrives merged into `filters`.
 */
export interface Lookup {
  predicate?: QueryPredicate;
  /** Lookup column (usually the primary key). */
  field: string;
  value: string;
  /** Additional equality constraints (tenant scope, ownership, ...). */
  filters?: Record<string, string>;
}

export interface ReadOptions {
  /** Lock the row against concurrent writers until the current transaction ends.
   * Requires the adapter's `rowLocks` capability and a transaction scope. */
  forUpdate?: boolean;
  /** Relations to include (allow-listed upstream). */
  include?: string[];
  /** Match soft-deleted records too (restore's pre-read, withDeleted reads). */
  withDeleted?: boolean;
}

export interface DeleteOptions {
  /**
   * Soft-delete column, when the model soft-deletes. The adapter stamps it
   * instead of removing the row; `undefined` means hard delete.
   */
  softDeleteField?: string;
}

export interface UpsertInput<Row> {
  /** Must constrain the UPDATE leg atomically; unsupported scopes must reject. */
  scope?: FilterCondition[];
  /** Column(s) whose conflict triggers update-instead-of-insert. */
  conflictTarget: string[];
  values: Partial<Row>;
}

/** Outcome of a filtered bulk write (`updateWhere`). */
export interface BulkOutcome<Row> {
  count: number;
  /** Patched rows, when the caller asked for `returnRecords`. */
  records?: Row[];
}

// ---------------------------------------------------------------------------
// Aggregate / search specs
// ---------------------------------------------------------------------------

/**
 * One aggregation within a (possibly multi-op) query — `?sum=amount&avg=age`
 * becomes two `AggregateField`s. `field` is `'*'` for `COUNT(*)`. `alias`
 * overrides the derived output key (the query-param path never sets it, so the
 * alias is derived from operation + field; see `getAggregateAlias`).
 */
export interface AggregateField {
  operation: AggregateOperation;
  field: string;
  alias?: string;
}

/** A validated aggregate query with one entry per requested operation and field. */
export interface AggregateSpec {
  aggregations: AggregateField[];
  groupBy?: string[];
  /** HAVING: output-alias → comparison-op (`eq|ne|gt|gte|lt|lte`) → threshold. */
  having?: Record<string, Record<string, string>>;
  /** Order groups by an aggregate alias or a `groupBy` column. */
  orderBy?: string;
  orderDirection?: SortDirection;
  /** Group-window pagination (grouped queries only). */
  limit?: number;
  offset?: number;
  filters: FilterCondition[];
}

/** One group bucket: the `groupBy` key columns + the aliased aggregate values. */
export interface AggregateBucket {
  key: Record<string, unknown>;
  values: Record<string, number | null>;
}

/**
 * Aggregate result (hono-crud 0.13 shape). Ungrouped queries return `values`
 * (aliased aggregate scalars); grouped queries return `groups` + `totalGroups`
 * (post-HAVING group count, before limit/offset).
 */
export interface AggregateResult {
  values?: Record<string, number | null>;
  groups?: AggregateBucket[];
  totalGroups?: number;
}

export interface SearchQuery {
  term: string;
  mode: SearchMode;
  /** Fields to search, with optional relevance weights. */
  fields: Array<{ field: string; weight?: number }>;
  filters: FilterCondition[];
  options: ListOptions;
}

/** A half-open character range within a search-highlight snippet. */
export interface SearchHighlightRange {
  start: number;
  end: number;
}

/**
 * Presentation-neutral search highlight. Consumers render `text` as text and
 * may decorate the validated ranges; the API never returns executable HTML.
 */
export interface SearchHighlight {
  text: string;
  ranges: SearchHighlightRange[];
}

export interface SearchHit<Row> {
  record: Row;
  score: number;
  highlights?: Record<string, SearchHighlight[]>;
  /** Fields that matched the query (surfaced in the search response). */
  matchedFields?: string[];
}
