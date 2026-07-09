/**
 * The five core verb executors (create/read/update/delete/list). Extended
 * verbs live in `./extended/` family modules registered through
 * `./extended/registry`. Shared stage helpers are in `./verb-helpers`.
 *
 * Canonical stage order (mutations): validate → tenant scope → transaction →
 * pre-read → write-policy → managed fields → before-hook → adapter op →
 * after-hook (in-tx) → read-shaping → envelope. Reads: parse → tenant scope +
 * policy pushdown → adapter op → read-policy (row filter/404 + field mask) →
 * read-shaping → envelope.
 */

import type { ListQuery, Page } from '../adapter/query-types';
import { ForbiddenException, NotFoundException } from '../envelope/errors';
import { applyComputedFieldsToArray } from '../model/computed-fields';
import { applyManagedInsertFields, applyManagedUpdateFields } from '../model/managed-fields';
import { canRead, canWrite, filterReadable, maskFields, pushdownConditions } from '../policies/evaluate';
import { parseListFilters } from '../query/filters';
import { applyFieldSelectionToArray } from '../query/field-selection';
import type { EngineRequest, EngineResult } from './engine-request';
import { captureAudit, captureVersion } from './capture';
import { runBeforeChain, runHooks } from './run-hooks';
import { envelopeOf } from './resource';
import {
  attachIncludes,
  buildHookContext,
  buildLookup,
  buildPolicyContext,
  listParseOptions,
  createSchemaFor,
  parseBody,
  updateSchemaFor,
  parseIncludeParam,
  passesPushdown,
  resolveSelection,
  scopeListQuery,
  shapeOne,
  type AnyResource,
} from './verb-helpers';

export type { AnyResource } from './verb-helpers';

type Row = Record<string, unknown>;
// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

export async function executeCreate(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const data = parseBody(await createSchemaFor(resource, req), req.body);

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

  await captureAudit(resource, req, 'create', {
    recordId: record[model.primaryKeys[0] ?? 'id'] as string | number,
    record,
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
  const patch = parseBody(await updateSchemaFor(resource, req), req.body);

  const { prior, current } = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const prior = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
    if (!prior) throw new NotFoundException(model.name, lookup.value);
    if (!(await canWrite(policyCtx, prior, model.policies))) {
      throw new ForbiddenException();
    }

    const managed = applyManagedUpdateFields(model, patch);
    // Version snapshot BEFORE the write: captures the pre-update state and
    // stamps the incremented version field onto `managed` (no-op when the
    // model does not version).
    await captureVersion(resource, prior, managed, req);
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
    return { prior, current };
  });

  await captureAudit(resource, req, 'update', {
    recordId: current[model.primaryKeys[0] ?? 'id'] as string | number,
    previousRecord: prior,
    record: current,
  });

  const shaped = await shapeOne(resource, policyCtx, req, current);
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

  const prior = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const prior = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
    if (!prior) throw new NotFoundException(model.name, lookup.value);
    if (!(await canWrite(policyCtx, prior, model.policies))) {
      throw new ForbiddenException();
    }

    // Snapshot the pre-delete state (no-op when the model does not version);
    // no write payload to stamp — the row is being removed.
    await captureVersion(resource, prior, undefined, req);
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
    return prior;
  });

  await captureAudit(resource, req, 'delete', {
    recordId: prior[model.primaryKeys[0] ?? 'id'] as string | number,
    previousRecord: prior,
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
    await attachIncludes(resource, req, scoped.options.include, fetched.result, scope, {
      withDeleted: scoped.options.withDeleted ?? false,
    });
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
