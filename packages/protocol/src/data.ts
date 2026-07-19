/**
 * Data-browser wire contract. Model discovery + row access shapes.
 *
 * `StudioFilterOperator` is a compatible subset of `@velajs/crud`'s
 * `FilterOperator` (`crud/packages/core/src/adapter/query-types.ts`), and
 * `StudioPageInfo` is a structural mirror of crud's `PageInfo` (snake_case
 * preserved). Drift guards against the real crud package land in the server
 * package; see the report for mirror source paths.
 */

/**
 * Grid filter operators — a subset of crud's `FILTER_OPERATORS`, chosen so every
 * member is assignment-compatible with crud's `FilterOperator`. `const` array +
 * derived union so compile-time type and runtime membership can't drift.
 */
export const STUDIO_FILTER_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'like',
  'ilike',
  'null',
  'between',
] as const;

/** Union of every supported grid filter operator. */
export type StudioFilterOperator = (typeof STUDIO_FILTER_OPERATORS)[number];

/** One grid filter clause. */
export interface StudioGridFilter {
  field: string;
  operator: StudioFilterOperator;
  value: unknown;
}

/** A single column in a model, derived from the model schema. */
export interface StudioColumn {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';
  pk: boolean;
  nullable: boolean;
  unique: boolean;
  /** Foreign-key reference, from `model.relations` foreignKey. */
  fk?: { table: string; relation: string };
  /** Managed field: timestamps / soft-delete / tenant. */
  managed: boolean;
}

/** Lightweight model listing entry. */
export interface StudioModelInfo {
  name: string;
  table: string;
  label: string;
  /** Adapter capability names available for this model (e.g. `search`, `aggregate`). */
  capabilities: string[];
}

/** Full descriptor for a single model. */
export interface StudioModelDescriptor {
  name: string;
  table: string;
  primaryKeys: string[];
  columns: StudioColumn[];
  relations: Array<{
    name: string;
    type: 'hasOne' | 'hasMany' | 'belongsTo';
    target: string;
    foreignKey: string;
    cascade?: string;
  }>;
  flags: { softDelete: boolean; multiTenant: boolean; versioning: boolean; audit: boolean };
  supports: { facets: boolean; search: boolean; cascade: boolean };
}

/** Request to list rows of a model. */
export interface ListRowsRequest {
  model: string;
  filters?: StudioGridFilter[];
  sort?: { field: string; order: 'asc' | 'desc' };
  page?: number;
  perPage?: number;
  cursor?: string;
  search?: string;
  withDeleted?: boolean;
}

/**
 * Pagination metadata — structural mirror of `@velajs/crud` `PageInfo`
 * (snake_case field names preserved for faithful mirroring).
 */
export interface StudioPageInfo {
  page: number;
  per_page: number;
  total_count?: number;
  total_pages?: number;
  has_next_page: boolean;
  has_prev_page: boolean;
  /** Next-page cursor (keyset pagination). Walks are next-only. */
  next_cursor?: string;
}

/** A page of untyped rows plus pagination metadata. */
export interface StudioRowPage {
  rows: Array<Record<string, unknown>>;
  info: StudioPageInfo;
}

/** Request to write (create or patch) a single row. */
export interface WriteRowRequest {
  model: string;
  /** Present for an update; absent for a create. */
  id?: string;
  patch: Record<string, unknown>;
  confirmToken?: string;
}

/** Request to delete rows (soft or hard). Destructive: `confirmToken` required. */
export interface DeleteRowsRequest {
  model: string;
  ids: string[];
  mode: 'soft' | 'hard';
  confirmToken: string;
}

/** Request to clear an entire table. Destructive: `confirmToken` required. */
export interface ClearTableRequest {
  model: string;
  confirmToken: string;
}

/** Request faceted counts for a field. */
export interface FacetsRequest {
  model: string;
  field: string;
  filters?: StudioGridFilter[];
  limit?: number;
}

/** Faceted count buckets. */
export interface FacetsResponse {
  buckets: Array<{ value: unknown; count: number }>;
}

/** Request a cascade-delete preview for the given rows. */
export interface CascadePreviewRequest {
  model: string;
  ids: string[];
}

/** The relations a cascade delete would touch. */
export interface CascadePreviewResponse {
  relations: Array<{ relation: string; target: string; action: string; affected: number }>;
}

/** Request to generate synthetic rows. */
export interface GenerateRowsRequest {
  model: string;
  count: number;
  overrides?: Record<string, unknown>;
}

/** Result of a generate-rows write. */
export interface GenerateRowsResponse {
  inserted: number;
}
