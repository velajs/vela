/**
 * Derive request-body schemas from a model's Zod schema.
 *
 *  - `deriveCreateSchema(model)` = `model.schema` minus generated primary keys,
 *    managed timestamp columns, and the tenant column (all engine-owned on
 *    writes — {@link getManagedInputExclusions}).
 *  - `deriveUpdateSchema(model, fieldsConfig?)` = the same base, then `blocked`
 *    fields removed and `allowed` fields kept, then `.partial()` (every field
 *    optional — the caller decides which are required).
 *
 * Override handling lives upstream: a consumer-supplied per-endpoint
 * `bodySchema` always wins and is never rewritten — this module only exports
 * the model-derived defaults.
 *
 * Parity note vs hono-crud 0.13 (`endpoints/create.ts` / `endpoints/update.ts`
 * `getBodySchema`): the derivation (strip managed fields; update = base
 * `.partial()` with allowed/blocked) is ported faithfully.
 *
 * DEFERRED (intentional parity gap): hono-crud additionally merges nested-write
 * relation shapes into the body schema when a relation's `nestedWrites` flags
 * allow it. The native `RelationConfig` carries no `nestedWrites` config, and
 * nested-write orchestration lives in the adapter driver — so nested-write
 * shape merging is NOT derived here. Tracked as a blind spot to revisit if the
 * model layer grows a nested-write authoring surface.
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { getManagedInputExclusions } from './managed-fields';
import type { Model } from './model.types';

/** Field allow/block-list for {@link deriveUpdateSchema}. */
export interface DeriveFieldsConfig {
  /** When set, only these fields survive (after managed/blocked removal). */
  allowed?: string[];
  /** These fields are removed in addition to the managed set. */
  blocked?: string[];
}

/**
 * `ZodObject.omit(...)` over a `string[]`, filtering names absent from the
 * schema first — Zod v4's `.omit()` THROWS on an unknown key, and the managed
 * exclusion set can reference renamed timestamp columns a given schema does not
 * declare. Omitting an absent key is a no-op anyway.
 */
function omitFields(schema: ZodObject<ZodRawShape>, exclude: string[]): ZodObject<ZodRawShape> {
  if (exclude.length === 0) return schema;
  const present = new Set(Object.keys(schema.shape));
  const applicable = exclude.filter((k) => present.has(k));
  if (applicable.length === 0) return schema;
  const mask = Object.fromEntries(applicable.map((k) => [k, true as const]));
  return schema.omit(mask) as unknown as ZodObject<ZodRawShape>;
}

/**
 * `ZodObject.pick(...)` over a `string[]`, filtering names absent from the
 * schema first (Zod v4's `.pick()` also throws on an unknown key).
 */
function pickFields(schema: ZodObject<ZodRawShape>, keep: string[]): ZodObject<ZodRawShape> {
  const present = new Set(Object.keys(schema.shape));
  const applicable = keep.filter((k) => present.has(k));
  const mask = Object.fromEntries(applicable.map((k) => [k, true as const]));
  return schema.pick(mask) as unknown as ZodObject<ZodRawShape>;
}

/**
 * The create-body schema: `model.schema` minus the engine-managed fields
 * (generated PKs + timestamp columns + tenant column).
 */
export function deriveCreateSchema(
  model: Pick<Model, 'schema' | 'id' | 'timestamps' | 'primaryKeys' | 'tenantField'>,
): ZodObject<ZodRawShape> {
  return omitFields(model.schema, getManagedInputExclusions(model));
}

/**
 * The update-body schema: the create base with `blocked` fields additionally
 * removed and `allowed` fields kept, then made fully `.partial()`.
 */
export function deriveUpdateSchema(
  model: Pick<Model, 'schema' | 'id' | 'timestamps' | 'primaryKeys' | 'tenantField'>,
  fieldsConfig: DeriveFieldsConfig = {},
): ZodObject<ZodRawShape> {
  let exclude = getManagedInputExclusions(model);
  if (fieldsConfig.blocked && fieldsConfig.blocked.length > 0) {
    exclude = [...exclude, ...fieldsConfig.blocked];
  }

  let schema = omitFields(model.schema, exclude);
  if (fieldsConfig.allowed) {
    schema = pickFields(schema, fieldsConfig.allowed);
  }

  return schema.partial() as unknown as ZodObject<ZodRawShape>;
}
