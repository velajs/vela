import { responseContract } from './operation-scope';
import { validatePredicate, matchesPredicate } from '../query/predicate';
/**
 * The five core verb executors. Canonical stage order (mutations):
 *
 *   validate → tenant scope → transaction → pre-read → write-policy →
 *   managed fields → before-hook → adapter op → after-hook (in-tx) →
 *   read-shaping → envelope
 *
 * Reads: parse → tenant scope + policy pushdown → adapter op → read-policy
 * (row filter/404 + field mask) → read-shaping → envelope.
 *
 * Read calls use `adapter.requestScope()`. Operations requiring rollback use
 * `adapter.transaction()`; D1 rejects unsupported callback transactions.
 */

import {
  ValidationPipe,
  validateSchema,
  SchemaValidationError,
  type StandardSchemaV1,
} from '@velajs/vela';
import type { AdapterScope, TransactionContext } from '../adapter/contract';
import type { FilterCondition, ListQuery, Lookup } from '../adapter/query-types';
import {
  CrudException,
  ForbiddenException,
  InputValidationException,
  NotFoundException,
} from '../envelope/errors';
import { applyComputedFields, applyComputedFieldsToArray } from '../model/computed-fields';
import { applyProfile, applyProfileToArray } from '../model/serialization-profile';
import {
  canCreate,
  canRead,
  canWrite,
  filterReadable,
  maskFields,
  pushdownConditions,
} from '../policies/evaluate';
import type { PolicyContext } from '../policies/types';
import { matchesFilter } from '../query/filters';
import { applyFieldSelection, parseFieldSelection } from '../query/field-selection';
import type { EngineRequest } from './engine-request';
import { deriveCreateSchema, deriveUpdateSchema } from '../model/schema-derive';
import type { HookContext } from './hook-types';
import type { CrudResource } from './resource';

type Row = Record<string, unknown>;

/** Runtime resources have schema-validated row and hook boundaries. */
export type AnyResource = CrudResource;

/** Hard ceiling for any engine-side scan used to emulate a native operation. */
export const MAX_FALLBACK_SCAN = 1_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function requireId(req: EngineRequest): string {
  if (req.id === undefined || req.id === '') {
    throw new InputValidationException('Missing id path parameter');
  }
  return typeof req.id === 'string' ? req.id : JSON.stringify(req.id);
}

export function buildHookContext(req: EngineRequest, scope: AdapterScope): HookContext {
  return {
    db: { tx: scope.tx },
    request: req.request,
    tenantId: req.vars?.tenantId,
    organizationId: req.vars?.organizationId,
    userId: req.vars?.userId,
    agentId: req.vars?.agentId,
    agentRunId: req.vars?.agentRunId,
  };
}

export function buildPolicyContext(req: EngineRequest): PolicyContext {
  return {
    user: req.vars?.user,
    tenantId: req.vars?.tenantId,
    organizationId: req.vars?.organizationId,
    userId: req.vars?.userId,
    // Policies receive a Request; direct engine invocations (tests, dispatch
    // outside HTTP) get a synthetic one.
    request: req.request ?? new Request('http://engine.internal/'),
  };
}

/**
 * Tenant models never execute without a non-empty tenant id. Keeping this at
 * the engine boundary protects direct `resource.execute(...)` calls as well as
 * HTTP routes and prevents middleware ordering mistakes from becoming an
 * unscoped query.
 */
export function requireTenantContext(resource: AnyResource, req: EngineRequest): void {
  if (resource.model.tenantField === undefined) return;
  const tenantId = req.vars?.tenantId;
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new CrudException('This operation requires a tenant context', 400, 'TENANT_REQUIRED');
  }
}

/** Fail closed when the model's create policy denies a validated input. */
export async function assertCreateAllowed(
  resource: AnyResource,
  policyCtx: PolicyContext,
  record: Row,
): Promise<void> {
  if (!(await canCreate(policyCtx, record, resource.model.policies))) {
    throw new ForbiddenException();
  }
}

/** Point-read authorization: pushdown + row predicate, rendered as a 404. */
export async function assertReadAllowed(
  resource: AnyResource,
  policyCtx: PolicyContext,
  record: Row,
  id?: string,
): Promise<void> {
  const policies = resource.model.policies;
  if (
    !passesPushdown(record, pushdownConditions(policyCtx, policies)) ||
    !(await canRead(policyCtx, record, policies))
  ) {
    throw new NotFoundException(resource.model.name, id);
  }
}

/**
 * Mutation authorization for an existing row.
 *
 * A write predicate never grants visibility by itself.  Every mutation must
 * first prove that the source row is readable (including read-pushdown), then
 * prove that it is writable.  This keeps all mutation executors on the same
 * fail-closed policy pipeline and prevents a write-only actor from probing or
 * mutating a row that is otherwise hidden from them.
 */
export async function assertWriteAllowed(
  resource: AnyResource,
  policyCtx: PolicyContext,
  record: Row,
): Promise<void> {
  const primaryKey = resource.model.primaryKeys[0] ?? 'id';
  await assertReadAllowed(resource, policyCtx, record, String(record[primaryKey] ?? ''));
  if (!(await canWrite(policyCtx, record, resource.model.policies))) {
    throw new ForbiddenException();
  }
}

/** Tenant scoping for point lookups — full resolution middleware lands in M3. */
export function tenantFilters(
  resource: AnyResource,
  req: EngineRequest,
): Record<string, string> | undefined {
  const field = resource.model.tenantField;
  const tenantId = req.vars?.tenantId;
  if (field === undefined || tenantId === undefined) return undefined;
  return { [field]: tenantId };
}

/** Request context for `adapter.transaction()` — the tenant at tx open (RLS GUCs). */
export function txCtx(req: EngineRequest): TransactionContext {
  return { tenantId: req.vars?.tenantId };
}

export function buildLookup(resource: AnyResource, req: EngineRequest): Lookup {
  const keys = resource.model.primaryKeys;
  let source: unknown =
    typeof req.id === 'object'
      ? req.id
      : keys.length > 1
        ? req.params
        : { [keys[0] ?? 'id']: requireId(req) };
  if (keys.length > 1 && typeof req.id === 'string') {
    try {
      source = JSON.parse(req.id);
    } catch {
      throw new InputValidationException('Compound IDs must contain every primary key');
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new InputValidationException('Invalid identifier');
  const parts = Object.fromEntries(Object.entries(source));
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = parts[key];
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      value === '' ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new InputValidationException(`Missing or invalid identifier '${key}'`);
    values[key] = String(value);
  }
  const [field = 'id', ...rest] = keys;
  return {
    field,
    value: values[field]!,
    filters: {
      ...Object.fromEntries(rest.map((key) => [key, values[key]!])),
      ...tenantFilters(resource, req),
    },
  };
}

export function lookupFromRow(resource: AnyResource, req: EngineRequest, row: Row): Lookup {
  const id: Record<string, string | number> = {};
  for (const key of resource.model.primaryKeys) {
    const value = row[key];
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new TypeError(`Invalid persisted identifier '${key}'`);
    id[key] = value;
  }
  return buildLookup(resource, { ...req, id });
}

/** Engine-side re-check of pushdown conditions on point reads. */
export function passesPushdown(row: Row, conditions: FilterCondition[]): boolean {
  return conditions.every((condition) =>
    matchesFilter(condition.operator === 'predicate' ? row : row[condition.field], condition),
  );
}

export async function parseBody(schema: StandardSchemaV1, body: unknown): Promise<Row> {
  try {
    const parsed = ValidationPipe.consumeValidated(body, schema)
      ? body
      : await validateSchema(schema, body ?? {});
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InputValidationException('CRUD input must validate to a record');
    }
    return Object.fromEntries(Object.entries(parsed));
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new InputValidationException(
        'Validation failed',
        error.issues.map((issue) => ({
          path: (issue.path ?? [])
            .map((part) => (typeof part === 'object' ? String(part.key) : String(part)))
            .join('.'),
          message: issue.message,
          code: 'validation',
        })),
      );
    }
    throw error;
  }
}

/**
 * The read-shaping tail shared by every verb that returns one row:
 * response read-check → computed fields → policy field mask →
 * serialization profile → field selection.  Mutation executors call this
 * too, so a successful write can never echo a representation that the actor
 * is not allowed to read. The profile strips BEFORE selection so an excluded
 * field stays absent even when `?fields=` requests it explicitly.
 */
export async function shapeOne(
  resource: AnyResource,
  policyCtx: PolicyContext,
  req: EngineRequest,
  row: Row,
  validateResponse = true,
): Promise<Row> {
  const primaryKey = resource.model.primaryKeys[0] ?? 'id';
  await assertReadAllowed(resource, policyCtx, row, String(row[primaryKey] ?? ''));
  let shaped = await applyComputedFields(resource.model, row);
  shaped = maskFields(policyCtx, shaped, resource.model.policies);
  shaped = applyProfile(resource.model, shaped);
  const selection = resolveSelection(resource, req);
  if (selection) shaped = applyFieldSelection(shaped, selection);
  return validateResponse ? responseContract(resource, shaped) : shaped;
}

export function resolveSelection(resource: AnyResource, req: EngineRequest) {
  const cfg = resource.config.fieldSelection;
  if (!cfg?.enabled) return undefined;
  const raw = req.query?.fields;
  const fieldsParam = Array.isArray(raw) ? raw.join(',') : raw;
  const model = resource.model;
  return parseFieldSelection(
    fieldsParam ?? null,
    {
      allowedFields: cfg.allowed,
      blockedFields: cfg.blocked,
      alwaysIncludeFields: cfg.alwaysInclude,
      defaultFields: cfg.defaults,
    },
    Object.keys(model.schema.shape),
    Object.keys(model.computedFields ?? {}),
    Object.keys(model.relations ?? {}),
  );
}

/** Attaches `?include=`d relations to rows via the adapter's batch loader. */
export async function attachIncludes(
  resource: AnyResource,
  req: EngineRequest,
  includes: string[] | undefined,
  rows: Row[],
  scope: AdapterScope,
  opts: { withDeleted?: boolean } = {},
): Promise<void> {
  if (!includes || includes.length === 0 || rows.length === 0) return;
  const loader = resource.config.adapter.relations;
  if (!loader) return;
  const model = resource.model;
  const pk = model.primaryKeys[0] ?? 'id';

  for (const name of includes) {
    const relation = model.relations?.[name];
    if (!relation) continue;
    const sameModel = relation.target === model.tableName;
    const targetTenantField = sameModel
      ? model.tenantField
      : relation.response?.tenantField === false
        ? undefined
        : relation.response?.tenantField;
    const targetSoftDeleteField = sameModel
      ? model.softDeleteField
      : relation.response?.softDeleteField === false
        ? undefined
        : relation.response?.softDeleteField;
    const authorization = sameModel
      ? resource.config.authorization
      : relation.response?.authorization;
    const plan =
      authorization === undefined
        ? { kind: 'allow' as const }
        : await authorization(buildPolicyContext(req), 'read');
    if (!plan || (plan.kind !== 'deny' && plan.kind !== 'conditional' && plan.kind !== 'allow'))
      throw new TypeError('Invalid relation authorization plan');
    const predicate =
      plan?.kind === 'deny'
        ? { op: 'false' as const }
        : plan?.kind === 'conditional'
          ? validatePredicate(
              plan.predicate,
              relation.schema ? new Set(Object.keys(relation.schema.shape)) : undefined,
            )
          : undefined;
    if (predicate && !resource.config.adapter.capabilities.has('structuredPredicates'))
      throw new CrudException(
        'Relation authorization requires structured predicate support',
        500,
        'PREDICATE_UNSUPPORTED',
      );
    if (targetTenantField !== undefined && req.vars?.tenantId === undefined) {
      throw new CrudException('This relation requires a tenant context', 400, 'TENANT_REQUIRED');
    }
    const loaded = await loader.load(
      rows,
      name,
      {
        ...(predicate ? { predicate } : {}),
        tenantField: targetTenantField,
        tenantValue: req.vars?.tenantId,
        ...(targetSoftDeleteField !== undefined && !opts.withDeleted
          ? { excludeDeletedField: targetSoftDeleteField }
          : {}),
      },
      scope,
    );
    const parentJoinField =
      relation.type === 'belongsTo' ? relation.foreignKey : (relation.localKey ?? pk);
    // Internal `defineModels` relations carry their target's response metadata.
    // Same-model relations use the current model directly. Resource definition
    // rejects enabled cross-model includes without an explicit response trust /
    // authorization contract, so this never silently emits unknown raw rows.
    const responseModel = relation.target === model.tableName ? model : relation.response;
    const policyCtx = buildPolicyContext(req);
    for (const row of rows) {
      const bucket = loaded.get(row[parentJoinField]) ?? [];
      let shaped = bucket.filter((record) => {
        if (predicate && !matchesPredicate(record, predicate)) return false;
        if (
          targetTenantField !== undefined &&
          (!Object.hasOwn(record, targetTenantField) ||
            String(record[targetTenantField]) !== String(req.vars?.tenantId))
        ) {
          return false;
        }
        return !(
          targetSoftDeleteField !== undefined &&
          !opts.withDeleted &&
          record[targetSoftDeleteField] != null
        );
      });
      if (responseModel) {
        shaped = shaped.filter((record) =>
          passesPushdown(record, pushdownConditions(policyCtx, responseModel.policies)),
        );
        shaped = await filterReadable(policyCtx, shaped, responseModel.policies);
        shaped = await applyComputedFieldsToArray(responseModel, shaped);
        shaped = shaped.map((record) => maskFields(policyCtx, record, responseModel.policies));
        shaped = applyProfileToArray(responseModel, shaped);
      }
      row[name] = relation.type === 'hasMany' ? shaped : (shaped[0] ?? null);
    }
  }
}

export function listParseOptions(resource: AnyResource) {
  const config = resource.config;
  return {
    filterFields: config.filterFields,
    filterConfig: config.filterConfig,
    searchFields: config.searchFields,
    sortFields: config.sortFields,
    defaultSort: config.defaultSort,
    defaultPerPage: config.pagination?.defaultPerPage,
    maxPerPage: config.pagination?.maxPerPage,
    cursorPaginationEnabled: config.pagination?.cursor?.enabled,
    cursorField: config.pagination?.cursor?.field,
    allowedIncludes: config.allowedIncludes,
    fieldSelectionEnabled: config.fieldSelection?.enabled,
    allowedSelectFields: config.fieldSelection?.allowed,
    blockedSelectFields: config.fieldSelection?.blocked,
    alwaysIncludeFields: config.fieldSelection?.alwaysInclude,
    defaultSelectFields: config.fieldSelection?.defaults,
  };
}

/** Merges tenant scope + policy pushdown into a parsed list query. */
export function scopeListQuery(
  resource: AnyResource,
  req: EngineRequest,
  policyCtx: PolicyContext,
  query: ListQuery,
): ListQuery {
  const filters = [...query.filters];
  const field = resource.model.tenantField;
  if (field !== undefined && req.vars?.tenantId !== undefined) {
    filters.push({ field, operator: 'eq', value: req.vars.tenantId });
  }
  filters.push(...pushdownConditions(policyCtx, resource.model.policies));
  return { filters, options: query.options };
}

/**
 * Run an adapter list as a bounded engine-side fallback. A backend that cannot
 * report totals is rejected when it fills the window because silently
 * computing over a truncated data set would be incorrect and attacker-controlled.
 */
export async function listFallbackRows(
  resource: AnyResource,
  query: ListQuery,
  scope: AdapterScope,
): Promise<Row[]> {
  const page = await resource.config.adapter.list(
    {
      filters: query.filters,
      options: { ...query.options, page: 1, per_page: MAX_FALLBACK_SCAN },
    },
    scope,
  );
  const total = page.result_info.total_count;
  if (
    (typeof total === 'number' && total > MAX_FALLBACK_SCAN) ||
    (total === undefined && page.result.length >= MAX_FALLBACK_SCAN)
  ) {
    throw new CrudException(
      `Engine fallback scan exceeds the ${MAX_FALLBACK_SCAN}-row safety limit`,
      400,
      'SCAN_LIMIT_EXCEEDED',
    );
  }
  return page.result;
}

export function parseIncludeParam(
  req: EngineRequest,
  allowed: string[] | undefined,
): string[] | undefined {
  const raw = req.query?.include;
  if (raw === undefined) return undefined;
  const names = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => value.split(','));
  const trimmed = names.map((name) => name.trim()).filter((name) => name.length > 0);
  if (!allowed || allowed.length === 0) return [];
  return trimmed.filter((name) => allowed.includes(name));
}

/**
 * The request-effective CREATE body schema. The compiled static schema is
 * used unless the model declares `resolveSchema` (per-tenant schemas — e.g.
 * tenant custom fields): then the model schema is resolved for the request
 * tenant and the body schema re-derived. An explicit `dto.create` override
 * always wins. Resolution is per-request (parity with hono-crud, whose
 * Model.resolveSchema ran on every request); resolvers may cache internally.
 */
export async function createSchemaFor(
  resource: AnyResource,
  req: EngineRequest,
): Promise<AnyResource['createSchema']> {
  const model = resource.model;
  if (
    resource.config.contracts?.create !== undefined ||
    resource.model.contracts?.create !== undefined ||
    resource.config.dto?.create !== undefined ||
    model.resolveSchema === undefined
  ) {
    return resource.createSchema;
  }
  const schema = await model.resolveSchema({ tenantId: req.vars?.tenantId });
  return deriveCreateSchema({ ...model, schema });
}

/** The request-effective UPDATE body schema — see {@link createSchemaFor}. */
export async function updateSchemaFor(
  resource: AnyResource,
  req: EngineRequest,
): Promise<AnyResource['updateSchema']> {
  const model = resource.model;
  if (
    resource.config.contracts?.update !== undefined ||
    resource.model.contracts?.update !== undefined ||
    resource.config.dto?.update !== undefined ||
    model.resolveSchema === undefined
  ) {
    return resource.updateSchema;
  }
  const schema = await model.resolveSchema({ tenantId: req.vars?.tenantId });
  return deriveUpdateSchema({ ...model, schema }, resource.config.updateFields ?? {});
}

/** Stable complete identifier for audit and legacy version-store display fields. */
export function rowIdentifier(resource: AnyResource, row: Row): string | number {
  const lookup = lookupFromRow(resource, {}, row);
  if (resource.model.primaryKeys.length === 1) {
    const value = row[lookup.field];
    if (typeof value === 'number') return value;
    return lookup.value;
  }
  return JSON.stringify(
    Object.fromEntries(resource.model.primaryKeys.map((key) => [key, row[key]])),
  );
}
