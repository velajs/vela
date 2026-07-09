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
 * Every adapter call runs inside `adapter.transaction()` — the only scope
 * source. Memory's scope is a free no-op sentinel; SQL adapters get the
 * atomicity the hook contract promises (two-snapshot after-hooks observe
 * pre-mutation state in the same transaction).
 */

import type { AdapterScope } from '../adapter/contract';
import type { FilterCondition, ListQuery, Lookup, Page } from '../adapter/query-types';
import {
  ForbiddenException,
  InputValidationException,
  NotFoundException,
} from '../envelope/errors';
import { applyComputedFields, applyComputedFieldsToArray } from '../model/computed-fields';
import { applyManagedInsertFields, applyManagedUpdateFields } from '../model/managed-fields';
import { canRead, canWrite, filterReadable, maskFields, pushdownConditions } from '../policies/evaluate';
import type { PolicyContext } from '../policies/types';
import { matchesFilter, parseListFilters } from '../query/filters';
import { applyFieldSelection, applyFieldSelectionToArray, parseFieldSelection } from '../query/field-selection';
import type { EngineRequest, EngineResult } from './engine-request';
import type { HookContext } from './hook-types';
import { runBeforeChain, runHooks } from './run-hooks';
import { envelopeOf, type CrudResource } from './resource';

type Row = Record<string, unknown>;

/**
 * Executors are written against the type-erased resource: internally every
 * row is a `Record<string, unknown>`, and `execute()` erases once at its
 * boundary (adapter method parameter positions make `CrudResource<T>`
 * effectively invariant, so `CrudResource<never>` is not a usable bottom).
 */
export type AnyResource = CrudResource<Row>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireId(req: EngineRequest): string {
  if (req.id === undefined || req.id === '') {
    throw new InputValidationException('Missing id path parameter');
  }
  return req.id;
}

function buildHookContext(req: EngineRequest, scope: AdapterScope): HookContext {
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

function buildPolicyContext(req: EngineRequest): PolicyContext {
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

/** Tenant scoping for point lookups — full resolution middleware lands in M3. */
function tenantFilters(resource: AnyResource, req: EngineRequest): Record<string, string> | undefined {
  const field = resource.model.tenantField;
  const tenantId = req.vars?.tenantId;
  if (field === undefined || tenantId === undefined) return undefined;
  return { [field]: tenantId };
}

function buildLookup(resource: AnyResource, req: EngineRequest): Lookup {
  return {
    field: resource.model.primaryKeys[0] ?? 'id',
    value: requireId(req),
    filters: tenantFilters(resource, req),
  };
}

/** Engine-side re-check of pushdown conditions on point reads. */
function passesPushdown(row: Row, conditions: FilterCondition[]): boolean {
  return conditions.every((condition) => matchesFilter(row[condition.field], condition));
}

function parseBody(schema: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: unknown } }, body: unknown): Row {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw InputValidationException.fromZodError(
      parsed.error as { issues: Array<{ path: Array<PropertyKey>; message: string; code: string }> },
    );
  }
  return parsed.data as Row;
}

/**
 * The read-shaping tail shared by every verb that returns rows:
 * computed fields → policy field mask → field selection.
 */
async function shapeOne(
  resource: AnyResource,
  policyCtx: PolicyContext,
  req: EngineRequest,
  row: Row,
): Promise<Row> {
  let shaped = await applyComputedFields(resource.model, row);
  shaped = maskFields(policyCtx, shaped, resource.model.policies) as Row;
  const selection = resolveSelection(resource, req);
  if (selection) shaped = applyFieldSelection(shaped, selection) as Row;
  return shaped;
}

function resolveSelection(resource: AnyResource, req: EngineRequest) {
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
async function attachIncludes(
  resource: AnyResource,
  req: EngineRequest,
  includes: string[] | undefined,
  rows: Row[],
  scope: AdapterScope,
): Promise<void> {
  if (!includes || includes.length === 0 || rows.length === 0) return;
  const loader = resource.config.adapter.relations;
  if (!loader) return;
  const model = resource.model;
  const pk = model.primaryKeys[0] ?? 'id';

  for (const name of includes) {
    const relation = model.relations?.[name];
    if (!relation) continue;
    const loaded = await loader.load(
      rows,
      name,
      {
        tenantField: model.tenantField,
        tenantValue: req.vars?.tenantId,
      },
      scope,
    );
    const parentJoinField =
      relation.type === 'belongsTo' ? relation.foreignKey : (relation.localKey ?? pk);
    for (const row of rows) {
      const bucket = loaded.get(row[parentJoinField]) ?? [];
      row[name] = relation.type === 'hasMany' ? bucket : (bucket[0] ?? null);
    }
  }
}

function listParseOptions(resource: AnyResource) {
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
function scopeListQuery(
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

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

export async function executeCreate(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const data = parseBody(resource.createSchema, req.body);

  if (model.tenantField !== undefined && req.vars?.tenantId !== undefined) {
    data[model.tenantField] = req.vars.tenantId;
  }

  const record = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const managed = applyManagedInsertFields(model, data, {
      databaseGeneratedId: config.adapter.capabilities.has('databaseGeneratedId'),
    });
    const input = (await runBeforeChain(
      config.hooks?.beforeMode ?? 'sequential',
      config.hooks?.beforeCreate ? [config.hooks.beforeCreate as never] : [],
      ctx,
      managed,
    )) as Row;

    let created = await config.adapter.create(input, scope);
    if (config.hooks?.afterCreate) {
      const replaced = await runBeforeChain(
        config.hooks.afterMode ?? 'sequential',
        [config.hooks.afterCreate as never],
        ctx,
        created,
      );
      created = replaced as Row;
    }
    return created;
  });

  const policyCtx = buildPolicyContext(req);
  const shaped = await shapeOne(resource, policyCtx, req, record);
  return { status: 201, body: envelopeOf(resource).success(shaped) };
}

export async function executeRead(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const policyCtx = buildPolicyContext(req);
  const lookup = buildLookup(resource, req);
  const includes = parseIncludeParam(req, config.allowedIncludes);

  const row = await config.adapter.transaction(async (scope) => {
    const found = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
    if (found) await attachIncludes(resource, req, includes, [found], scope);
    return found;
  });

  if (!row) throw new NotFoundException(resource.model.name, lookup.value);
  if (!passesPushdown(row, pushdownConditions(policyCtx, resource.model.policies))) {
    throw new NotFoundException(resource.model.name, lookup.value);
  }
  if (!(await canRead(policyCtx, row, resource.model.policies))) {
    throw new NotFoundException(resource.model.name, lookup.value);
  }

  let shaped = await shapeOne(resource, policyCtx, req, row);
  if (config.hooks?.transformRead) {
    const ctx = buildHookContext(req, { tx: undefined });
    shaped = (await config.hooks.transformRead(ctx, shaped as never)) as Row;
  }
  return { status: 200, body: envelopeOf(resource).success(shaped) };
}

export async function executeUpdate(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const policyCtx = buildPolicyContext(req);
  const lookup = buildLookup(resource, req);
  const patch = parseBody(resource.updateSchema, req.body);

  const updated = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const prior = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
    if (!prior) throw new NotFoundException(model.name, lookup.value);
    if (!(await canWrite(policyCtx, prior, model.policies))) {
      throw new ForbiddenException();
    }

    const managed = applyManagedUpdateFields(model, patch);
    if (config.hooks?.beforeUpdate) {
      await config.hooks.beforeUpdate(ctx, managed as never, prior as never);
    }

    const current = (await config.adapter.update(lookup, managed as never, scope)) as Row | null;
    if (!current) throw new NotFoundException(model.name, lookup.value);

    if (config.hooks?.afterUpdate) {
      await runHooks(config.hooks.afterMode ?? 'sequential', [
        () => config.hooks!.afterUpdate!(ctx, prior as never, current as never),
      ], []);
    }
    return current;
  });

  const shaped = await shapeOne(resource, policyCtx, req, updated);
  return { status: 200, body: envelopeOf(resource).success(shaped) };
}

export async function executeDelete(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const policyCtx = buildPolicyContext(req);
  const lookup = buildLookup(resource, req);

  await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const prior = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
    if (!prior) throw new NotFoundException(model.name, lookup.value);
    if (!(await canWrite(policyCtx, prior, model.policies))) {
      throw new ForbiddenException();
    }

    if (config.hooks?.beforeDelete) await config.hooks.beforeDelete(ctx, prior as never);

    const deleted = await config.adapter.delete(
      lookup,
      { softDeleteField: model.softDeleteField },
      scope,
    );
    if (!deleted) throw new NotFoundException(model.name, lookup.value);

    if (config.hooks?.afterDelete) {
      await runHooks(config.hooks.afterMode ?? 'sequential', [
        () => config.hooks!.afterDelete!(ctx, prior as never),
      ], []);
    }
  });

  return { status: 200, body: envelopeOf(resource).success({ deleted: true }) };
}

export async function executeList(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const policyCtx = buildPolicyContext(req);

  const parsed = parseListFilters(req.query ?? {}, listParseOptions(resource));
  const scoped = scopeListQuery(resource, req, policyCtx, parsed);

  if (config.hooks?.beforeList) {
    await config.hooks.beforeList(buildHookContext(req, { tx: undefined }));
  }

  const page = await config.adapter.transaction(async (scope) => {
    const fetched = (await config.adapter.list(scoped as never, scope)) as Page<Row>;
    await attachIncludes(resource, req, scoped.options.include, fetched.result, scope);
    return fetched;
  });

  // Read policy: silently drop rows the caller may not see, then shape.
  const readable = await filterReadable(policyCtx, page.result, resource.model.policies);
  let rows = await applyComputedFieldsToArray(resource.model, readable);
  rows = rows.map((row) => maskFields(policyCtx, row, resource.model.policies) as Row);
  if (config.hooks?.transformList) {
    const ctx = buildHookContext(req, { tx: undefined });
    rows = (await Promise.all(rows.map((row) => config.hooks!.transformList!(ctx, row as never)))) as Row[];
  }
  const selection = resolveSelection(resource, req);
  if (selection) rows = applyFieldSelectionToArray(rows, selection) as Row[];

  const result: Page<Row> = { result: rows, result_info: page.result_info };
  if (config.hooks?.afterList) {
    const ctx = buildHookContext(req, { tx: undefined });
    await config.hooks.afterList(ctx, result as never);
  }

  return {
    status: 200,
    body: envelopeOf(resource).success(result.result, result.result_info),
  };
}

function parseIncludeParam(req: EngineRequest, allowed: string[] | undefined): string[] | undefined {
  const raw = req.query?.include;
  if (raw === undefined) return undefined;
  const names = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => value.split(','));
  const trimmed = names.map((name) => name.trim()).filter((name) => name.length > 0);
  if (!allowed || allowed.length === 0) return [];
  return trimmed.filter((name) => allowed.includes(name));
}
