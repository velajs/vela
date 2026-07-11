/**
 * Nested-write orchestration for the single create/update verbs: split the
 * validated body into parent fields + per-relation nested payloads, translate
 * the update ops envelope into the adapter's `NestedWriteOperations`, and
 * fail loudly where nesting is not supported (extended verbs; adapters
 * without the driver). Dispatch itself happens inside the parent write's
 * transaction scope in `verbs.ts` — reusing the existing `NestedWriteDriver`
 * contract, never a parallel system.
 */

import type { NestedWriteDriver, NestedWriteOperations } from '../adapter/contract';
import { ConfigurationException, InputValidationException } from '../envelope/errors';
import type { Model } from '../model/model.types';
import type { AnyResource } from './verb-helpers';

type Row = Record<string, unknown>;

type HasRelations = Pick<Model, 'relations'>;

/** Relation names accepting nested payloads on CREATE (`allowCreate`). */
export function nestedCreateRelations(model: HasRelations): string[] {
  return Object.entries(model.relations ?? {})
    .filter(([, rel]) => rel.nestedWrites?.allowCreate === true && rel.type !== 'belongsTo')
    .map(([name]) => name);
}

/** Relation names accepting an ops envelope on UPDATE (any flag). */
export function nestedUpdateRelations(model: HasRelations): string[] {
  return Object.entries(model.relations ?? {})
    .filter(([, rel]) => {
      const f = rel.nestedWrites;
      if (!f || rel.type === 'belongsTo') return false;
      return (
        f.allowCreate === true ||
        f.allowUpdate === true ||
        f.allowDelete === true ||
        f.allowConnect === true ||
        f.allowDisconnect === true
      );
    })
    .map(([name]) => name);
}

/**
 * A nested payload carrying no work: absent, an empty child array, or an ops
 * envelope zod stripped to `{}` (non-enabled ops are unknown keys). Empty
 * payloads never demand a driver and never dispatch.
 */
function isEmptyPayload(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** Split a validated body into parent fields + present nested payloads. */
export function splitNested(
  data: Row,
  names: string[],
): { main: Row; nested: Map<string, unknown> } {
  const nested = new Map<string, unknown>();
  if (names.length === 0 || !names.some((name) => name in data)) {
    return { main: data, nested };
  }
  const main: Row = { ...data };
  for (const name of names) {
    if (name in main) {
      if (!isEmptyPayload(main[name])) nested.set(name, main[name]);
      delete main[name];
    }
  }
  return { main, nested };
}

interface NestedUpdateEnvelope {
  create?: Row | Row[];
  update?: Array<Row & { id: string | number }>;
  delete?: Array<string | number>;
  connect?: Array<string | number>;
  disconnect?: Array<string | number>;
  set?: { id: string | number } | null;
}

/**
 * Translate the validated update ops envelope into the driver's
 * `NestedWriteOperations` (related rows are matched by `id` — hono-crud
 * parity; a related PK other than `id` is out of scope).
 */
export function toNestedOps(value: unknown): NestedWriteOperations {
  const env = value as NestedUpdateEnvelope;
  const ops: NestedWriteOperations = {};
  if (env.create !== undefined) {
    ops.create = Array.isArray(env.create) ? env.create : [env.create];
  }
  if (env.update !== undefined) {
    // Drop id-only entries (nothing to set) — SQL drivers reject `.set({})`.
    ops.update = env.update
      .map(({ id, ...data }) => ({ where: { id }, data }))
      .filter((op) => Object.keys(op.data).length > 0);
  }
  if (env.delete !== undefined) ops.delete = env.delete.map((id) => ({ id }));
  if (env.connect !== undefined) ops.connect = env.connect.map((id) => ({ id }));
  if (env.disconnect !== undefined) ops.disconnect = env.disconnect.map((id) => ({ id }));
  if (env.set !== undefined) {
    // null = disconnect all; { id } = relink exactly that record.
    ops.set = env.set === null ? [] : [{ id: env.set.id }];
  }
  return ops;
}

/**
 * Stamp engine-managed columns onto nested CREATE records: the request tenant
 * (forced — the child shape strips a caller-supplied value) and timestamps
 * (defaulted when absent), each ONLY when the child schema declares the
 * parent model's column name. The engine has no child Model, so uniform
 * column naming is the contract; children whose schemas use other names are
 * the child table's own concern (DB defaults / RLS).
 */
export function stampNestedCreates(
  model: Pick<Model, 'tenantField' | 'timestamps' | 'relations'>,
  relationName: string,
  records: Row[],
  tenantId: string | undefined,
): Row[] {
  const schema = model.relations?.[relationName]?.schema;
  if (!schema) return records;
  const childKeys = new Set(Object.keys(schema.shape));
  const { createdAt, updatedAt } = model.timestamps;
  const now = Date.now();
  return records.map((record) => {
    const out: Row = { ...record };
    if (model.tenantField && tenantId !== undefined && childKeys.has(model.tenantField)) {
      out[model.tenantField] = tenantId;
    }
    if (createdAt && childKeys.has(createdAt) && !(createdAt in record)) out[createdAt] = now;
    if (updatedAt && childKeys.has(updatedAt) && !(updatedAt in record)) out[updatedAt] = now;
    return out;
  });
}

/** The adapter's nested driver — loud when nesting is configured without it. */
export function requireNestedDriver(resource: AnyResource): NestedWriteDriver<Row> {
  const adapter = resource.config.adapter;
  if (!adapter.capabilities.has('nestedWrites') || adapter.nested === undefined) {
    throw new ConfigurationException(
      `Resource '${resource.model.name}': nested writes require an adapter with the 'nestedWrites' capability`,
    );
  }
  return adapter.nested;
}

/**
 * Reject nested payloads on verbs without a dispatch seam (batch family,
 * upsert, clone, bulkPatch, import) — a silent drop would insert the relation
 * key as a column.
 */
export function assertNoNestedWrites(model: HasRelations, data: Row, verb: string): void {
  const names = nestedUpdateRelations(model);
  if (names.length === 0) return;
  const present = names.filter((name) => name in data);
  if (present.length > 0) {
    throw new InputValidationException(
      `Nested-write payloads are not supported on '${verb}' (relation keys: ${present.join(', ')})`,
    );
  }
}
