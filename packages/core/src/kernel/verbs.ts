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
import { ConflictException, ForbiddenException, NotFoundException } from '../envelope/errors';
import { applyComputedFields, applyComputedFieldsToArray } from '../model/computed-fields';
import { applyProfile, applyProfileToArray } from '../model/serialization-profile';
import { generateETag, matchesIfMatch, matchesIfNoneMatch } from './etag';
import {
  nestedCreateRelations,
  nestedUpdateRelations,
  requireNestedDriver,
  splitNested,
  stampNestedCreates,
  toNestedOps,
} from './nested-writes';
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
  txCtx,
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

  // Nested payloads (relations opted in via nestedWrites) split off the
  // parent body and dispatch to the driver inside the SAME transaction.
  const { main, nested } = splitNested(data, nestedCreateRelations(model));
  const nestedDriver = nested.size > 0 ? requireNestedDriver(resource) : undefined;

  const record = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const managed = applyManagedInsertFields(model, main, {
      databaseGeneratedId: config.adapter.capabilities.has('databaseGeneratedId'),
    });
    const input = (await runBeforeChain(
      config.hooks?.beforeMode ?? 'sequential',
      config.hooks?.beforeCreate ? [config.hooks.beforeCreate as never] : [],
      ctx,
      managed,
    )) as Row;

    let created = await config.adapter.create(input, scope);
    if (nestedDriver) {
      for (const [name, value] of nested) {
        const records = stampNestedCreates(
          model,
          name,
          (Array.isArray(value) ? value : [value]) as Row[],
          req.vars?.tenantId,
        );
        await nestedDriver.createNested(created, name, records, scope);
      }
    }
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
  }, txCtx(req));

  await captureAudit(resource, req, 'create', {
    recordId: record[model.primaryKeys[0] ?? 'id'] as string | number,
    record,
  });

  const policyCtx = buildPolicyContext(req);
  const shaped = await shapeOne(resource, policyCtx, req, record);
  return { status: 201, body: envelopeOf(resource).success(shaped) };
}

/**
 * The representation an ETag hashes: computed → mask → profile, WITHOUT
 * request field-selection — the token must be stable across `?fields=`
 * variants so a read's ETag matches the update-side If-Match comparison.
 */
async function etagFor(
  resource: AnyResource,
  policyCtx: ReturnType<typeof buildPolicyContext>,
  row: Row,
): Promise<string> {
  // Copy + strip relation keys FIRST: attachIncludes mutates rows in place,
  // and relation embeds must never fold into the tag — an include-read's
  // ETag has to satisfy the update-side If-Match comparison, which hashes
  // the bare row.
  const bare: Row = { ...row };
  for (const name of Object.keys(resource.model.relations ?? {})) delete bare[name];
  let shaped = await applyComputedFields(resource.model, bare);
  shaped = maskFields(policyCtx, shaped, resource.model.policies) as Row;
  shaped = applyProfile(resource.model, shaped);
  return generateETag(shaped);
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
  }, txCtx(req));

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
  if (config.etag) {
    const tag = await etagFor(resource, policyCtx, row);
    if (matchesIfNoneMatch(req.request?.headers.get('If-None-Match'), tag)) {
      return { status: 304, body: null, headers: { ETag: tag } };
    }
    return { status: 200, body: envelopeOf(resource).success(shaped), headers: { ETag: tag } };
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

  // Nested ops envelopes split off the patch and apply inside the SAME
  // transaction, after the parent row is updated.
  const { main: patchMain, nested } = splitNested(patch, nestedUpdateRelations(model));
  const nestedDriver = nested.size > 0 ? requireNestedDriver(resource) : undefined;

  const { prior, current } = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const prior = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
    if (!prior) throw new NotFoundException(model.name, lookup.value);
    if (!(await canWrite(policyCtx, prior, model.policies))) {
      throw new ForbiddenException();
    }

    // If-Match optimistic concurrency: mismatch is a 409 CONFLICT (hono-crud
    // parity — not 412). An absent header is an unconditional update.
    if (config.etag) {
      const ifMatch = req.request?.headers.get('If-Match');
      if (ifMatch != null && !matchesIfMatch(ifMatch, await etagFor(resource, policyCtx, prior))) {
        throw new ConflictException('Resource has been modified by another request');
      }
    }

    const managed = applyManagedUpdateFields(model, patchMain);
    // Version snapshot BEFORE the write: captures the pre-update state and
    // stamps the incremented version field onto `managed` (no-op when the
    // model does not version).
    await captureVersion(resource, prior, managed, req);
    if (config.hooks?.beforeUpdate) {
      await config.hooks.beforeUpdate(ctx, managed as never, prior as never);
    }

    const current = (await config.adapter.update(lookup, managed as never, scope)) as Row | null;
    if (!current) throw new NotFoundException(model.name, lookup.value);

    if (nestedDriver) {
      for (const [name, value] of nested) {
        const ops = toNestedOps(value);
        if (ops.create) {
          ops.create = stampNestedCreates(model, name, ops.create as Row[], req.vars?.tenantId);
        }
        await nestedDriver.applyNested(current, name, ops, scope);
      }
    }

    if (config.hooks?.afterUpdate) {
      await runHooks(config.hooks.afterMode ?? 'sequential', [
        () => config.hooks!.afterUpdate!(ctx, prior as never, current as never),
      ], []);
    }
    return { prior, current };
  }, txCtx(req));

  await captureAudit(resource, req, 'update', {
    recordId: current[model.primaryKeys[0] ?? 'id'] as string | number,
    previousRecord: prior,
    record: current,
  });

  const shaped = await shapeOne(resource, policyCtx, req, current);
  if (config.etag) {
    return {
      status: 200,
      body: envelopeOf(resource).success(shaped),
      headers: { ETag: await etagFor(resource, policyCtx, current) },
    };
  }
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
  }, txCtx(req));

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
  }, txCtx(req));

  // Read policy: silently drop rows the caller may not see, then shape.
  const readable = await filterReadable(policyCtx, page.result, resource.model.policies);
  let rows = await applyComputedFieldsToArray(resource.model, readable);
  rows = rows.map((row) => maskFields(policyCtx, row, resource.model.policies) as Row);
  rows = applyProfileToArray(resource.model, rows);
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
