/**
 * The model authoring surface for the native Vela CRUD engine.
 *
 * `ModelConfig` is what an author writes; `Model` is the normalized shape
 * `defineModel` returns with every default resolved (id strategy, primary
 * keys, timestamp field names, soft-delete / tenant fields flattened to
 * `softDeleteField` / `tenantField`). Downstream layers (managed-fields,
 * soft-delete, schema-derive, adapters, kernel) consume the NORMALIZED
 * `Model` only — they never re-derive defaults.
 *
 * Behavior parity notes reference hono-crud 0.13 (`core/types.ts`), simplified
 * for the native engine: no Hono coupling, a flattened normalized output, and
 * `timestamps` ON by default (see `defineModel`).
 */

import { z } from 'zod';
import type { ZodObject, ZodRawShape, ZodType } from 'zod';
import type { ModelPolicies } from '../policies/types';

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/** The inferred property keys of a Zod object schema. */
export type SchemaKeys<T extends ZodObject<ZodRawShape>> = keyof z.infer<T>;

// ---------------------------------------------------------------------------
// Primary-key generation strategy
// ---------------------------------------------------------------------------

/**
 * Primary-key generation strategy for {@link ModelConfig.id}.
 *
 * - `'uuid'` — DEFAULT (also the behavior when unset): `crypto.randomUUID()`.
 * - `'database'` — the adapter omits the PK from the insert payload so the
 *   DB/ORM column default fills it; the value is read back via the adapter's
 *   create-return. Requires the adapter's `databaseGeneratedId` capability —
 *   otherwise the first write throws a `ConfigurationException`.
 * - `'client'` — the CALLER supplies the PK: it stays (with its authored,
 *   typically required shape) in the derived create-body schema, the engine
 *   performs no generation, and no adapter capability is needed. A create
 *   reaching the insert seam without a PK is a 400 (InputValidationException).
 * - `() => string | number` — a custom JS generator (ulid / nanoid / ksuid /
 *   snowflake), invoked at every write site.
 */
export type IdStrategy = 'uuid' | 'database' | 'client' | (() => string | number);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export type RelationType = 'hasOne' | 'hasMany' | 'belongsTo';

/** Cascade behavior when a parent record is (soft-)deleted. */
export type CascadeAction = 'cascade' | 'setNull' | 'restrict' | 'noAction';

export interface CascadeConfig {
  /** Action when the parent row is hard-deleted. @default 'noAction' */
  onDelete?: CascadeAction;
  /** Action when the parent row is soft-deleted. @default 'noAction' */
  onSoftDelete?: CascadeAction;
}

/**
 * One relation on a model. `target` is a registry key while authored inside a
 * `defineModels({...})` call; the factory rewrites it to the target model's
 * `tableName` (the form adapters resolve by). Authored standalone (a raw
 * `RelationConfig`), `target` already names the physical table.
 */
export interface RelationConfig<TTable = unknown> {
  type: RelationType;
  /**
   * Registry key of the related model (rewritten to its `tableName` by
   * {@link defineModels}), or the physical table name for standalone configs.
   */
  target?: string;
  /** Foreign-key column name. */
  foreignKey: string;
  /** Local key column name (defaults to the primary key). */
  localKey?: string;
  /** The related model's schema (auto-populated by {@link defineModels}). */
  schema?: ZodObject<ZodRawShape>;
  /** ORM table reference for the related model (auto-populated for drizzle). */
  table?: TTable;
  /** Cascade behavior on parent (soft-)delete. */
  cascade?: CascadeConfig;
  /**
   * Opt this relation out of {@link defineModels} sibling-key checking and
   * auto-population — for cross-package / polymorphic targets authored raw.
   */
  external?: boolean;
}

/** Map of relation names to their configurations. */
export type RelationsConfig = Record<string, RelationConfig>;

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** Author-facing timestamps configuration. */
export type TimestampsInput = false | { createdAt?: string | false; updatedAt?: string | false };

/**
 * Normalized timestamp field names. A `string` names the column to stamp;
 * `false` disables that column. Values are epoch-ms numbers (`Date.now()`).
 */
export interface NormalizedTimestamps {
  createdAt: string | false;
  updatedAt: string | false;
}

// ---------------------------------------------------------------------------
// Soft delete / multi-tenant author-facing configs
// ---------------------------------------------------------------------------

export type SoftDeleteInput = boolean | { field: string };
export type MultiTenantInput = boolean | { field: string };

// ---------------------------------------------------------------------------
// Computed fields
// ---------------------------------------------------------------------------

export type ComputedFieldFn<T = Record<string, unknown>, R = unknown> = (record: T) => R | Promise<R>;

export interface ComputedFieldConfig<T = Record<string, unknown>, R = unknown> {
  /** Computes the field value from the (stored) record. Sync or async. */
  compute: ComputedFieldFn<T, R>;
  /** Optional Zod schema for the computed field (OpenAPI documentation). */
  schema?: ZodType<R>;
  /** Schema fields this computed field reads (authoring metadata only). */
  dependsOn?: (keyof T & string)[];
}

/** Map of computed-field names to their configurations. */
export type ComputedFieldsConfig<T = Record<string, unknown>> = Record<
  string,
  ComputedFieldConfig<T, unknown>
>;

// ---------------------------------------------------------------------------
// Per-request schema resolution
// ---------------------------------------------------------------------------

/** Context handed to {@link ModelConfig.resolveSchema} for per-tenant schemas. */
export interface SchemaResolveContext {
  tenantId?: string;
}

// ---------------------------------------------------------------------------
// Model config (author input) and Model (normalized output)
// ---------------------------------------------------------------------------

/**
 * Author-facing model configuration passed to {@link defineModel}. Optional
 * fields carry defaults resolved into the normalized {@link Model}.
 *
 * @template T - the Zod object schema for this model
 * @template TTable - optional ORM table type (drizzle Table, etc.)
 * @template TRelations - the literal-keyed relations map
 */
export interface ModelConfig<
  T extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>,
  TTable = unknown,
  TRelations extends RelationsConfig = RelationsConfig,
> {
  /** Singular resource name (e.g. `'user'`). */
  name: string;
  /** Plural resource name. @default `${name}s` */
  namePlural?: string;
  /** Physical table / store name. */
  tableName: string;
  /** Zod schema for validation and type inference. */
  schema: T;
  /** Primary-key column names. @default ['id'] */
  primaryKeys?: Array<SchemaKeys<T> & string>;
  /** Primary-key generation strategy. @default 'uuid' */
  id?: IdStrategy;
  /**
   * Auto-managed timestamp columns (epoch-ms). @default `{ createdAt:
   * 'createdAt', updatedAt: 'updatedAt' }` — timestamps are ON by default in
   * the native engine. `false` disables both; an object renames or disables
   * (`field: false`) either column.
   */
  timestamps?: TimestampsInput;
  /** Soft delete. @default off; `true` uses field `'deletedAt'`. */
  softDelete?: SoftDeleteInput;
  /** Multi-tenancy. @default off; `true` uses field `'tenantId'`. */
  multiTenant?: MultiTenantInput;
  /** Enable per-update history records. @default false */
  versioning?: boolean;
  /** Enable audit logging. @default false */
  audit?: boolean;
  /** Relations, loaded via `?include=`. */
  relations?: TRelations;
  /** Computed (runtime-only) fields added to responses. */
  computedFields?: ComputedFieldsConfig<z.infer<T>>;
  /** Strip fields from every response body (hono-crud finalize-pipeline). */
  serializationProfile?: SerializationProfile;
  /** Row/field-level access policies applied uniformly by the engine. */
  policies?: ModelPolicies<z.infer<T>>;
  /** Per-request (per-tenant) schema override; falls back to `schema`. */
  resolveSchema?: (ctx: SchemaResolveContext) => T | Promise<T>;
  /** ORM table reference (drizzle Table, etc.). */
  table?: TTable;
}

/**
 * Response-serialization profile (hono-crud 0.13 finalize-pipeline parity).
 * Excluded fields are REMOVED from every response body
 * (`'field' in record === false`) — list/read/write/batch/upsert/clone/
 * restore/search/export/import, plus SAME-model embedded relation rows;
 * aggregate requests referencing an excluded field are rejected (400).
 * The fields stay fully writable and intact at storage: filters/sorts match
 * them, the persistence-side before/after lifecycle hooks and version/audit
 * snapshots see the full row. The strip wins over `?fields=` and
 * `fieldSelection.alwaysInclude`.
 *
 * Caveats: the response-transform hooks (`transformRead`/`transformList`)
 * run AFTER the strip (hono-crud's profile-before-transform order) — they see
 * the stripped row and their output is not re-stripped. Embedded relation
 * rows of OTHER models are attached raw (per-relation shaping is the
 * relation-scoping backlog item; policy masks share the limitation). Entries
 * are plain strings (they may name computed or relation fields), so a
 * misspelled entry silently no-ops — keep the list in sync with renames.
 * hono-crud's `include`/`alwaysInclude`/`transform` profile options are
 * deliberately not ported yet — `exclude` is the proven consumer need.
 */
export interface SerializationProfile {
  /** Field names stripped from every response. */
  exclude?: string[];
}

/**
 * The NORMALIZED model — every default from {@link ModelConfig} resolved.
 * `softDeleteField` / `tenantField` are present only when enabled;
 * `timestamps` is always the normalized field-name pair.
 */
export interface Model<
  T extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>,
  TTable = unknown,
  TRelations extends RelationsConfig = RelationsConfig,
> {
  name: string;
  namePlural: string;
  tableName: string;
  schema: T;
  primaryKeys: string[];
  id: IdStrategy;
  timestamps: NormalizedTimestamps;
  /** Resolved soft-delete column, or `undefined` when disabled. */
  softDeleteField?: string;
  /** Resolved tenant column, or `undefined` when disabled. */
  tenantField?: string;
  versioning: boolean;
  audit: boolean;
  relations?: TRelations;
  computedFields?: ComputedFieldsConfig<z.infer<T>>;
  serializationProfile?: SerializationProfile;
  policies?: ModelPolicies<z.infer<T>>;
  resolveSchema?: (ctx: SchemaResolveContext) => T | Promise<T>;
  table?: TTable;
}
