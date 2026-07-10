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
      nested.set(name, main[name]);
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
    ops.update = env.update.map(({ id, ...data }) => ({ where: { id }, data }));
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
