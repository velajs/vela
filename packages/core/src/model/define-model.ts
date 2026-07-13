/**
 * `defineModel` — normalize an author's {@link ModelConfig} into the
 * {@link Model} the engine consumes. Every default is resolved here, once, so
 * no downstream layer re-derives them:
 *
 *  - `primaryKeys` → `['id']` when unset
 *  - `id` → `'uuid'` when unset
 *  - `namePlural` → `${name}s` when unset
 *  - `timestamps` → normalized `{ createdAt, updatedAt }` field-name pair,
 *    ON by default (see {@link normalizeTimestamps})
 *  - `softDelete` / `multiTenant` → flattened to `softDeleteField` /
 *    `tenantField` (`undefined` when disabled)
 *  - `versioning` / `audit` → `false` when unset
 *
 * Parity note vs hono-crud 0.13: hono-crud's `defineModel` is an identity
 * function and defaults are resolved lazily by scattered `getXConfig`
 * helpers. The native engine resolves eagerly into a flat normalized shape,
 * and — deliberately — `timestamps` DEFAULTS ON (hono-crud defaulted OFF).
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { ConfigurationException } from '../envelope/errors';
import type {
  Model,
  ModelConfig,
  MultiTenantInput,
  NormalizedTimestamps,
  RelationConfig,
  RelationsConfig,
  SoftDeleteInput,
  TimestampsInput,
} from './model.types';

const DEFAULT_CREATED_AT = 'createdAt';
const DEFAULT_UPDATED_AT = 'updatedAt';
const DEFAULT_SOFT_DELETE_FIELD = 'deletedAt';
const DEFAULT_TENANT_FIELD = 'tenantId';

/**
 * Resolve the timestamps configuration into a `{ createdAt, updatedAt }` pair
 * of column names (or `false` per column). Native-engine default: ON with the
 * conventional names. `false` disables both; per-field `false` disables one.
 */
export function normalizeTimestamps(timestamps: TimestampsInput | undefined): NormalizedTimestamps {
  if (timestamps === false) {
    return { createdAt: false, updatedAt: false };
  }
  const cfg = timestamps ?? {};
  return {
    createdAt: cfg.createdAt === undefined ? DEFAULT_CREATED_AT : cfg.createdAt,
    updatedAt: cfg.updatedAt === undefined ? DEFAULT_UPDATED_AT : cfg.updatedAt,
  };
}

/** Resolve the soft-delete column name, or `undefined` when disabled. */
export function normalizeSoftDeleteField(
  softDelete: SoftDeleteInput | undefined,
): string | undefined {
  if (!softDelete) return undefined;
  if (softDelete === true) return DEFAULT_SOFT_DELETE_FIELD;
  return softDelete.field ?? DEFAULT_SOFT_DELETE_FIELD;
}

/** Resolve the tenant column name, or `undefined` when disabled. */
export function normalizeTenantField(
  multiTenant: MultiTenantInput | undefined,
): string | undefined {
  if (!multiTenant) return undefined;
  if (multiTenant === true) return DEFAULT_TENANT_FIELD;
  return multiTenant.field ?? DEFAULT_TENANT_FIELD;
}

/**
 * Normalize an author's {@link ModelConfig} into a {@link Model}. Returns a
 * FRESH object — the input config is never mutated. Relations are passed
 * through by reference (cross-model wiring is {@link defineModels}' job).
 */
export function defineModel<
  T extends ZodObject<ZodRawShape>,
  TTable = unknown,
  TRelations extends RelationsConfig = RelationsConfig,
>(
  config: ModelConfig<T, TTable, TRelations>,
): Model<T, TTable, { [K in keyof TRelations & string]: RelationConfig }> {
  const normalized: Model<T, TTable, { [K in keyof TRelations & string]: RelationConfig }> = {
    name: config.name,
    namePlural: config.namePlural ?? `${config.name}s`,
    tableName: config.tableName,
    schema: config.schema,
    primaryKeys: config.primaryKeys ? [...config.primaryKeys] : ['id'],
    id: config.id ?? 'uuid',
    timestamps: normalizeTimestamps(config.timestamps),
    versioning: config.versioning ?? false,
    audit: config.audit ?? false,
    relations: config.relations as unknown as {
      [K in keyof TRelations & string]: RelationConfig;
    },
  };

  const softDeleteField = normalizeSoftDeleteField(config.softDelete);
  if (softDeleteField !== undefined) normalized.softDeleteField = softDeleteField;

  const tenantField = normalizeTenantField(config.multiTenant);
  if (tenantField !== undefined) normalized.tenantField = tenantField;

  // Loud, never silent: a unique column absent from the schema would make
  // the constraint silently unenforceable — fail at definition time.
  if (config.unique !== undefined) {
    const shape = new Set(Object.keys(config.schema.shape));
    const tuples = config.unique.map((entry) => (Array.isArray(entry) ? entry : [entry]));
    for (const tuple of tuples) {
      if (tuple.length === 0) {
        throw new ConfigurationException(`Model '${config.name}': empty unique tuple`);
      }
      for (const column of tuple) {
        if (!shape.has(column)) {
          throw new ConfigurationException(
            `Model '${config.name}': unique column '${column}' is not in the schema`,
          );
        }
      }
    }
    normalized.unique = tuples;
  }

  // Loud, never silent: nested writes only work in the has* direction (the
  // driver stamps the FK on the RELATED row keyed by the parent) and need the
  // related schema to derive the write shape — fail at definition time.
  for (const [name, rel] of Object.entries(
    (config.relations ?? {}) as Record<string, RelationConfig>,
  )) {
    if (rel?.nestedWrites === undefined) continue;
    if (rel.type === 'belongsTo') {
      throw new ConfigurationException(
        `Model '${config.name}': nestedWrites is not supported on belongsTo relation '${name}'`,
      );
    }
    if (rel.schema === undefined) {
      throw new ConfigurationException(
        `Model '${config.name}': nestedWrites on relation '${name}' requires the relation 'schema'`,
      );
    }
    if (rel.nestedWrites.allowConnect === true && tenantField !== undefined) {
      // Not an error: RLS-backed deployments legitimately rely on the DB for
      // isolation (the drizzle onOpenTransaction seam) — but the engine
      // cannot scope connect/set by tenant, so say it loudly.
      console.warn(
        `[@velajs/crud] Model '${config.name}': relation '${name}' enables ` +
          `nestedWrites.allowConnect on a tenant-scoped model — connect/set relink related ` +
          `rows by id with NO tenant/ownership check in the engine; enforce isolation at ` +
          `the database (RLS) or leave allowConnect off`,
      );
    }
  }

  if (config.computedFields !== undefined) normalized.computedFields = config.computedFields;
  if (config.serializationProfile !== undefined) {
    normalized.serializationProfile = config.serializationProfile;
  }
  if (config.policies !== undefined) normalized.policies = config.policies;
  if (config.resolveSchema !== undefined) normalized.resolveSchema = config.resolveSchema;
  if (config.table !== undefined) normalized.table = config.table;

  return normalized;
}
