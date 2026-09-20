/**
 * Derive request-body schemas from a model's Zod schema.
 *
 *  - `deriveCreateSchema(model)` = `model.schema` minus generated primary keys
 *    (RETAINED under `id: 'client'` — the caller supplies them), managed
 *    timestamp columns, and the tenant column (all engine-owned on writes —
 *    {@link getManagedInputExclusions}).
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
 * Nested writes (hono-crud `nested-writes.ts` parity): when a relation's
 * `nestedWrites` flags opt in, the relation's write shape is merged into the
 * derived bodies — CREATE gets the child shape (array for hasMany), UPDATE
 * gets an ops envelope gated per flag. The child shape omits exactly
 * `['id', foreignKey]` (child timestamps/tenant columns are NOT stripped —
 * hono-crud parity). Models with no opted-in relation return the base schema
 * unchanged (same reference path), preserving `id: 'client'` PK retention
 * and the serialization-profile behavior untouched.
 */

import { z, type ZodObject, type ZodRawShape, type ZodType } from 'zod';
import { getManagedInputExclusions } from './managed-fields';
import type { Model, RelationConfig } from './model.types';

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

/** Relations whose `nestedWrites` flags opt them into a given derivation. */
function nestableRelations(
  relations: Record<string, RelationConfig> | undefined,
  wants: (flags: NonNullable<RelationConfig['nestedWrites']>) => boolean,
): Array<[string, RelationConfig]> {
  return Object.entries(relations ?? {}).filter(([, rel]) => {
    if (!rel.nestedWrites || rel.type === 'belongsTo' || rel.schema === undefined) return false;
    return wants(rel.nestedWrites);
  });
}

/**
 * Child write shape: the related schema minus `['id', foreignKey]` (hono-crud
 * parity) plus the parent's tenant column — the engine force-stamps the
 * request tenant onto nested creates, so a caller-supplied value must never
 * validate (cross-tenant child writes).
 */
function childShape(rel: RelationConfig, tenantField: string | undefined): ZodObject<ZodRawShape> {
  const exclude = ['id', rel.foreignKey, ...(rel.response?.primaryKeys ?? [])];
  const targetTenantField =
    rel.response?.tenantField === false ? undefined : (rel.response?.tenantField ?? tenantField);
  if (targetTenantField !== undefined) exclude.push(targetTenantField);
  const targetTimestamps = rel.response?.timestamps;
  if (targetTimestamps?.createdAt) exclude.push(targetTimestamps.createdAt);
  if (targetTimestamps?.updatedAt) exclude.push(targetTimestamps.updatedAt);
  const targetSoftDeleteField =
    rel.response?.softDeleteField === false ? undefined : rel.response?.softDeleteField;
  if (targetSoftDeleteField !== undefined) exclude.push(targetSoftDeleteField);
  return omitFields(rel.schema as ZodObject<ZodRawShape>, exclude);
}

const NESTED_ID = z.union([z.string(), z.number()]);

/** Merge opted-in relations' CREATE shapes onto the base body schema. */
function mergeNestedCreate(
  base: ZodObject<ZodRawShape>,
  relations: Record<string, RelationConfig> | undefined,
  tenantField: string | undefined,
): ZodObject<ZodRawShape> {
  const merged: Record<string, ZodType> = {};
  for (const [name, rel] of nestableRelations(relations, (f) => f.allowCreate === true)) {
    const child = childShape(rel, tenantField);
    merged[name] = rel.type === 'hasMany' ? z.array(child).optional() : child.optional();
  }
  if (Object.keys(merged).length === 0) return base;
  return base.extend(merged) as unknown as ZodObject<ZodRawShape>;
}

/** Merge opted-in relations' UPDATE ops envelopes onto the base body schema. */
function mergeNestedUpdate(
  base: ZodObject<ZodRawShape>,
  relations: Record<string, RelationConfig> | undefined,
  tenantField: string | undefined,
): ZodObject<ZodRawShape> {
  const merged: Record<string, ZodType> = {};
  const anyFlag = (f: NonNullable<RelationConfig['nestedWrites']>) =>
    f.allowCreate === true ||
    f.allowUpdate === true ||
    f.allowDelete === true ||
    f.allowConnect === true ||
    f.allowDisconnect === true;
  for (const [name, rel] of nestableRelations(relations, anyFlag)) {
    const flags = rel.nestedWrites!;
    const child = childShape(rel, tenantField);
    const ops: Record<string, ZodType> = {};
    if (flags.allowCreate) {
      // hasOne stays single-object on the update leg too — an array would
      // silently violate the declared 1:1 cardinality.
      ops.create =
        rel.type === 'hasMany' ? z.union([child, z.array(child)]).optional() : child.optional();
    }
    if (flags.allowUpdate) {
      ops.update = z.array(child.partial().extend({ id: NESTED_ID })).optional();
    }
    if (flags.allowDelete) ops.delete = z.array(NESTED_ID).optional();
    if (flags.allowConnect) ops.connect = z.array(NESTED_ID).optional();
    if (flags.allowConnect && flags.allowDisconnect) {
      // `set` both relinks AND disconnects-all (null), so it demands BOTH
      // flags — allowConnect alone must not grant mass detachment.
      // Relink is by id; create-via-set is a documented hono-crud deviation.
      ops.set = z.union([z.object({ id: NESTED_ID }), z.null()]).optional();
    }
    if (flags.allowDisconnect) ops.disconnect = z.array(NESTED_ID).optional();
    merged[name] = z.object(ops).optional();
  }
  if (Object.keys(merged).length === 0) return base;
  return base.extend(merged) as unknown as ZodObject<ZodRawShape>;
}

/**
 * The create-body schema: `model.schema` minus the engine-managed fields
 * (generated PKs + timestamp columns + tenant column). Under `id: 'client'`
 * the PK is RETAINED at its authored shape — the caller supplies it; every
 * consumer (static schema, resolveSchema re-derive, OpenAPI DTO) flows
 * through here. Update-side derivation always excludes the PK. Relations
 * with `nestedWrites.allowCreate` merge their child shape onto the body.
 */
export function deriveCreateSchema(
  model: Pick<
    Model,
    'schema' | 'id' | 'timestamps' | 'primaryKeys' | 'tenantField' | 'softDeleteField' | 'relations'
  >,
): ZodObject<ZodRawShape> {
  const base = omitFields(
    model.schema,
    getManagedInputExclusions(model, { includePrimaryKeys: model.id !== 'client' }),
  );
  return mergeNestedCreate(base, model.relations, model.tenantField);
}

/**
 * The update-body schema: the create base with `blocked` fields additionally
 * removed and `allowed` fields kept, then made fully `.partial()`. Relations
 * with any `nestedWrites` flag merge their ops envelope onto the body.
 */
export function deriveUpdateSchema(
  model: Pick<
    Model,
    'schema' | 'id' | 'timestamps' | 'primaryKeys' | 'tenantField' | 'softDeleteField' | 'relations'
  >,
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

  const partial = schema.partial() as unknown as ZodObject<ZodRawShape>;
  return mergeNestedUpdate(partial, model.relations, model.tenantField);
}
