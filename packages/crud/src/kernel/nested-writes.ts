/**
 * Nested-write orchestration for the single create/update verbs: split the
 * validated body into parent fields + per-relation nested payloads, translate
 * the update ops envelope into the adapter's `NestedWriteOperations`, and
 * fail loudly where nesting is not supported (extended verbs; adapters
 * without the driver). Dispatch itself happens inside the parent write's
 * transaction scope in `verbs.ts` — reusing the existing `NestedWriteDriver`
 * contract, never a parallel system.
 */

import type {
  AdapterScope,
  NestedWriteDriver,
  NestedWriteInspection,
  NestedWriteOperations,
} from '../adapter/contract';
import {
  ConfigurationException,
  CrudException,
  ForbiddenException,
  InputValidationException,
} from '../envelope/errors';
import type { Model } from '../model/model.types';
import { canCreate, canWrite } from '../policies/evaluate';
import type { ModelPolicies, PolicyContext } from '../policies/types';
import type { AnyResource } from './verb-helpers';
import { matchesPredicate, validatePredicate, type QueryPredicate } from '../query/predicate';
import type { CrudEndpointName } from '../verb-table';

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
export function toNestedOps(
  value: unknown,
  targetScope?: Record<string, unknown>,
): NestedWriteOperations {
  const env = value as NestedUpdateEnvelope;
  const ops: NestedWriteOperations = {};
  if (targetScope !== undefined) ops.targetScope = targetScope;
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
 * Stamp engine-managed columns onto nested CREATE records from target-model
 * relation metadata: strip target PKs, force the trusted request tenant,
 * remove the soft-delete marker, and overwrite managed timestamps. This is a
 * final persistence-boundary check after custom DTO parsing.
 */
export function stampNestedCreates(
  model: Pick<
    Model,
    'tableName' | 'primaryKeys' | 'tenantField' | 'timestamps' | 'softDeleteField' | 'relations'
  >,
  relationName: string,
  records: Row[],
  tenantId: string | undefined,
): Row[] {
  const relation = model.relations?.[relationName];
  const schema = relation?.schema;
  if (!schema) return records;
  const sameModel = relation?.target === model.tableName;
  const targetTenantField = sameModel
    ? model.tenantField
    : relation?.response?.tenantField === false
      ? undefined
      : relation?.response?.tenantField;
  const targetSoftDeleteField = sameModel
    ? model.softDeleteField
    : relation?.response?.softDeleteField === false
      ? undefined
      : relation?.response?.softDeleteField;
  const targetTimestamps = sameModel ? model.timestamps : relation?.response?.timestamps;
  const targetPrimaryKeys = sameModel ? model.primaryKeys : relation?.response?.primaryKeys;
  if (targetTenantField !== undefined && tenantId === undefined) {
    throw new CrudException('This nested write requires a tenant context', 400, 'TENANT_REQUIRED');
  }
  const childKeys = new Set(Object.keys(schema.shape));
  const createdAt = targetTimestamps?.createdAt;
  const updatedAt = targetTimestamps?.updatedAt;
  const now = Date.now();
  return records.map((record) => {
    const out: Row = { ...record };
    // A custom DTO can expose managed target columns that the derived child
    // schema omits. Strip them again at the persistence boundary so a nested
    // create cannot overwrite an existing target row by choosing its PK.
    for (const primaryKey of targetPrimaryKeys ?? ['id']) delete out[primaryKey];
    if (targetTenantField !== undefined) {
      out[targetTenantField] = tenantId;
    }
    if (targetSoftDeleteField !== undefined) delete out[targetSoftDeleteField];
    if (createdAt && childKeys.has(createdAt)) out[createdAt] = now;
    if (updatedAt && childKeys.has(updatedAt)) out[updatedAt] = now;
    return out;
  });
}

/** Server-derived target tenant scope for nested existing-row operations. */
export function nestedTargetScope(
  model: Pick<Model, 'name' | 'tableName' | 'tenantField' | 'relations'>,
  relationName: string,
  tenantId: string | undefined,
): Record<string, unknown> {
  const relation = relationFor(model, relationName);
  const targetTenantField =
    relation.target === model.tableName
      ? model.tenantField
      : relation.response?.tenantField === false
        ? undefined
        : relation.response?.tenantField;
  if (targetTenantField === undefined) return {};
  if (tenantId === undefined) {
    throw new CrudException('This nested write requires a tenant context', 400, 'TENANT_REQUIRED');
  }
  return { [targetTenantField]: tenantId };
}

function relationFor(
  model: Pick<Model, 'name' | 'relations'>,
  relationName: string,
): NonNullable<Model['relations']>[string] {
  const relation = model.relations?.[relationName];
  if (relation === undefined) {
    throw new ConfigurationException(
      `Model '${model.name}': unknown nested relation '${relationName}'`,
    );
  }
  return relation;
}

/** Target-model create policy for children, evaluated before either write. */
export async function assertNestedCreatesAllowed(
  model: Pick<Model, 'name' | 'relations'>,
  relationName: string,
  policyCtx: PolicyContext,
  records: Row[],
): Promise<void> {
  const relation = relationFor(model, relationName);
  const policies = relation.response?.policies;
  const predicate = await nestedPredicate(relation, policyCtx, 'create');
  for (const record of records) {
    if (predicate && !matchesPredicate(record, predicate)) throw new ForbiddenException();
    if (!(await canCreate(policyCtx, record, policies))) throw new ForbiddenException();
  }
}

async function nestedPredicate(
  relation: NonNullable<Model['relations']>[string],
  context: PolicyContext,
  verb: CrudEndpointName,
): Promise<QueryPredicate | undefined> {
  const authorization = relation.response?.authorization;
  if (authorization === undefined) return undefined;
  const plan = await authorization(context, verb);
  if (!plan || typeof plan !== 'object') throw new TypeError('Invalid nested authorization plan');
  if (plan.kind === 'allow') return undefined;
  if (plan.kind === 'deny') throw new ForbiddenException();
  if (plan.kind !== 'conditional') throw new TypeError('Invalid nested authorization plan');
  return validatePredicate(
    plan.predicate,
    relation.schema ? new Set(Object.keys(relation.schema.shape)) : undefined,
  );
}

const INSPECTION_ARRAYS = [
  'update',
  'delete',
  'connect',
  'disconnect',
  'setConnect',
  'setDisconnect',
] as const satisfies ReadonlyArray<keyof NestedWriteInspection>;

function assertInspectionShape(value: unknown, modelName: string): NestedWriteInspection<Row> {
  if (value === null || typeof value !== 'object') {
    throw new ConfigurationException(
      `Model '${modelName}': nested-write driver returned an invalid target inspection`,
    );
  }
  for (const field of INSPECTION_ARRAYS) {
    if (!Array.isArray((value as Record<string, unknown>)[field])) {
      throw new ConfigurationException(
        `Model '${modelName}': nested-write target inspection is missing '${field}'`,
      );
    }
  }
  return value as NestedWriteInspection<Row>;
}

function scalarEqual(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  const comparable = (value: unknown): value is string | number =>
    typeof value === 'string' || typeof value === 'number';
  return comparable(actual) && comparable(expected) && String(actual) === String(expected);
}

function matches(row: Row, selector: Record<string, unknown>): boolean {
  return Object.entries(selector).every(
    ([field, expected]) => Object.hasOwn(row, field) && scalarEqual(row[field], expected),
  );
}

async function assertTargetAllowed(
  row: Row | null,
  selector: Record<string, unknown> | undefined,
  targetScope: Record<string, unknown>,
  policyCtx: PolicyContext,
  policies: ModelPolicies<Row> | undefined,
  softDeleteField?: string,
): Promise<void> {
  if (row !== null && (typeof row !== 'object' || Array.isArray(row))) {
    throw new ConfigurationException('Nested-write driver returned an invalid target row');
  }
  // A selector that is missing, outside the trusted tenant scope, or not the
  // row the adapter claims to have inspected is indistinguishable to callers.
  if (row === null || !matches(row, targetScope) || (selector && !matches(row, selector))) {
    throw new ForbiddenException();
  }
  if (softDeleteField !== undefined && row[softDeleteField] != null) {
    throw new ForbiddenException();
  }
  if (!(await canWrite(policyCtx, row, policies))) throw new ForbiddenException();
}

/**
 * Inspect and authorize every existing target before a nested mutation. The
 * inspection and the later adapter mutation share `scope`, closing the
 * check/use gap for transactional adapters. This also validates target
 * existence and the trusted tenant scope even when the target has no custom
 * write predicate.
 */
export async function assertNestedOperationsAllowed(
  model: Pick<Model, 'name' | 'tableName' | 'softDeleteField' | 'relations'>,
  relationName: string,
  policyCtx: PolicyContext,
  parent: Row,
  operations: NestedWriteOperations,
  driver: NestedWriteDriver<Row>,
  scope: AdapterScope,
): Promise<void> {
  const relation = relationFor(model, relationName);
  const policies = relation.response?.policies;
  const predicates: QueryPredicate[] = [];
  if (operations.delete?.length) {
    const p = await nestedPredicate(relation, policyCtx, 'delete');
    if (p) predicates.push(p);
  }
  if (
    operations.update?.length ||
    operations.connect?.length ||
    operations.disconnect?.length ||
    operations.set
  ) {
    const p = await nestedPredicate(relation, policyCtx, 'update');
    if (p) predicates.push(p);
  }
  if (predicates.length) operations.targetPredicate = { op: 'and', args: predicates };
  for (const { data } of operations.update ?? []) {
    for (const [key, value] of Object.entries(operations.targetScope ?? {}))
      if (Object.hasOwn(data, key) && !scalarEqual(data[key], value))
        throw new ForbiddenException();
    for (const key of [relation.foreignKey, ...(relation.response?.primaryKeys ?? ['id'])])
      if (Object.hasOwn(data, key))
        throw new ForbiddenException('Nested updates cannot change identity or parent');
  }
  const targetSoftDeleteField =
    relation.target === model.tableName
      ? model.softDeleteField
      : relation.response?.softDeleteField === false
        ? undefined
        : relation.response?.softDeleteField;
  await assertNestedCreatesAllowed(
    model,
    relationName,
    policyCtx,
    (operations.create ?? []) as Row[],
  );

  const needsInspection =
    (operations.update?.length ?? 0) > 0 ||
    (operations.delete?.length ?? 0) > 0 ||
    (operations.connect?.length ?? 0) > 0 ||
    (operations.disconnect?.length ?? 0) > 0 ||
    operations.set !== undefined;
  if (!needsInspection) return;

  const inspection = assertInspectionShape(
    await driver.inspectNestedTargets(parent, relationName, operations, scope),
    model.name,
  );
  const aligned: Array<{
    selectors: Array<Record<string, unknown>>;
    rows: Array<Row | null>;
  }> = [
    { selectors: operations.update?.map((entry) => entry.where) ?? [], rows: inspection.update },
    { selectors: operations.delete ?? [], rows: inspection.delete },
    { selectors: operations.connect ?? [], rows: inspection.connect },
    { selectors: operations.disconnect ?? [], rows: inspection.disconnect },
    { selectors: operations.set ?? [], rows: inspection.setConnect },
  ];
  const targetScope = operations.targetScope ?? {};
  for (const rows of Object.values(inspection))
    for (const row of rows) {
      if (row && operations.targetPredicate && !matchesPredicate(row, operations.targetPredicate))
        throw new ForbiddenException();
    }
  for (const { selectors, rows } of aligned) {
    if (selectors.length !== rows.length) {
      throw new ConfigurationException(
        `Model '${model.name}': nested-write driver returned an incomplete target inspection`,
      );
    }
    for (let index = 0; index < selectors.length; index++) {
      await assertTargetAllowed(
        rows[index] ?? null,
        selectors[index],
        targetScope,
        policyCtx,
        policies,
        targetSoftDeleteField,
      );
    }
  }
  for (const row of inspection.setDisconnect) {
    if (row === null || typeof row !== 'object') {
      throw new ConfigurationException(
        `Model '${model.name}': nested-write driver returned an invalid set target`,
      );
    }
    await assertTargetAllowed(
      row,
      undefined,
      targetScope,
      policyCtx,
      policies,
      targetSoftDeleteField,
    );
  }
}

/** The adapter's nested driver — loud when nesting is configured without it. */
export function requireNestedDriver(resource: AnyResource): NestedWriteDriver<Row> {
  const adapter = resource.config.adapter;
  if (
    Object.values(resource.model.relations ?? {}).some((rel) => rel.response?.authorization) &&
    (!adapter.capabilities.has('nestedPredicates') || !adapter.capabilities.has('transactions'))
  )
    throw new ConfigurationException(
      'Nested authorization requires transactional predicate support',
    );
  if (
    !adapter.capabilities.has('nestedWrites') ||
    adapter.nested === undefined ||
    typeof adapter.nested.inspectNestedTargets !== 'function' ||
    typeof adapter.nested.createNested !== 'function' ||
    typeof adapter.nested.applyNested !== 'function'
  ) {
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
