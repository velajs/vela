import { rowIdentifier } from './verb-helpers';
import type { CursorBinding } from '../query/cursor-codec';
import { projectPage, responseContract } from './operation-scope';
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

import { safeParse } from 'zod';
import type { Page } from '../adapter/query-types';
import {
  ConflictException,
  CrudException,
  InputValidationException,
  NotFoundException,
} from '../envelope/errors';
import { applyComputedFields, applyComputedFieldsToArray } from '../model/computed-fields';
import { applyProfile, applyProfileToArray } from '../model/serialization-profile';
import { generateETag, matchesIfMatch, matchesIfNoneMatch } from './etag';
import {
  assertNestedCreatesAllowed,
  assertNestedOperationsAllowed,
  nestedCreateRelations,
  nestedTargetScope,
  nestedUpdateRelations,
  requireNestedDriver,
  splitNested,
  stampNestedCreates,
  toNestedOps,
} from './nested-writes';
import { applyManagedInsertFields, applyManagedUpdateFields } from '../model/managed-fields';
import { filterReadable, maskFields } from '../policies/evaluate';
import { parseListFilters } from '../query/filters';
import { applyFieldSelectionToArray } from '../query/field-selection';
import {
  buildKeysetPage,
  buildOffsetPageInfo,
  compareKeysetRows,
  cursorValue,
  isAfterKeyset,
  resolveKeyset,
} from '../query/pagination';
import type { EngineRequest, EngineResult } from './engine-request';
import { captureAudit } from './capture';
import { runBeforeChain, runHooks } from './run-hooks';
import { envelopeOf } from './resource';
import {
  attachIncludes,
  assertCreateAllowed,
  assertReadAllowed,
  assertWriteAllowed,
  buildHookContext,
  buildLookup,
  buildPolicyContext,
  listParseOptions,
  listFallbackRows,
  createSchemaFor,
  parseBody,
  updateSchemaFor,
  parseIncludeParam,
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
  const data = await parseBody(await createSchemaFor(resource, req), req.body);

  if (model.tenantField !== undefined && req.vars?.tenantId !== undefined) {
    data[model.tenantField] = req.vars.tenantId;
  }

  // Nested payloads (relations opted in via nestedWrites) split off the
  // parent body and dispatch to the driver inside the SAME transaction.
  const { main, nested } = splitNested(data, nestedCreateRelations(model));
  const nestedDriver = nested.size > 0 ? requireNestedDriver(resource) : undefined;
  const policyCtx = buildPolicyContext(req);

  // A single INSERT is atomic on D1. After-hooks/nested writes require rollback.
  const createScope =
    config.adapter.capabilities.has('transactions') ||
    nestedDriver ||
    config.hooks?.beforeCreate ||
    config.hooks?.afterCreate
      ? config.adapter.transaction.bind(config.adapter)
      : config.adapter.requestScope.bind(config.adapter);
  const record = await createScope(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const managed = applyManagedInsertFields(model, main, {
      databaseGeneratedId: config.adapter.capabilities.has('databaseGeneratedId'),
      tenantId: req.vars?.tenantId,
    });
    const input = await runBeforeChain(
      config.hooks?.beforeMode ?? 'sequential',
      config.hooks?.beforeCreate ? [config.hooks.beforeCreate] : [],
      ctx,
      managed,
    );
    await assertCreateAllowed(resource, policyCtx, input);

    const preparedNested = new Map<string, Row[]>();
    if (nestedDriver) {
      for (const [name, value] of nested) {
        const records = stampNestedCreates(
          model,
          name,
          Array.isArray(value) ? value : [value],
          req.vars?.tenantId,
        );
        await assertNestedCreatesAllowed(model, name, policyCtx, records);
        preparedNested.set(name, records);
      }
    }

    let created = await config.adapter.create(input, scope);
    if (nestedDriver) {
      for (const [name, records] of preparedNested) {
        await nestedDriver.createNested(created, name, records, scope);
      }
    }
    if (config.hooks?.afterCreate) {
      const replaced = await runBeforeChain(
        config.hooks?.afterMode ?? 'sequential',
        [config.hooks.afterCreate],
        ctx,
        created,
      );
      created = replaced;
    }
    return created;
  }, txCtx(req));

  await captureAudit(resource, req, 'create', {
    recordId: rowIdentifier(resource, record),
    record,
  });

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
  shaped = maskFields(policyCtx, shaped, resource.model.policies);
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

  const row = await config.adapter.requestScope(async (scope) => {
    const ctx = buildHookContext(req, scope);
    if (config.hooks?.beforeRead) await config.hooks.beforeRead(ctx, lookup.value);
    const found = await config.adapter.readOne(lookup, {}, scope);
    if (!found) return null;
    await assertReadAllowed(resource, policyCtx, found, lookup.value);
    // Hooks receive a detached row: returning/mutating it must not modify storage.
    const observed = structuredClone(found);
    const current = config.hooks?.afterRead
      ? await runBeforeChain(
          config.hooks.afterMode ?? 'sequential',
          [config.hooks.afterRead],
          ctx,
          observed,
        )
      : observed;
    if (config.hooks?.afterRead)
      await assertReadAllowed(resource, policyCtx, current, lookup.value);
    await attachIncludes(resource, req, includes, [current], scope);
    return { current, stored: found };
  }, txCtx(req));

  if (!row) throw new NotFoundException(resource.model.name, lookup.value);
  const shaped = await shapeOne(resource, policyCtx, req, row.current, false);
  let output: unknown = shaped;
  if (config.hooks?.transformRead) {
    const ctx = buildHookContext(req, { tx: undefined });
    output = await config.hooks.transformRead(ctx, shaped);
  }
  if (config.contracts?.response ?? resource.model.contracts?.response)
    output = await responseContract(resource, parseRecord(output));
  if (config.etag) {
    const tag = await etagFor(resource, policyCtx, row.stored);
    if (matchesIfNoneMatch(req.request?.headers.get('If-None-Match'), tag)) {
      return { status: 304, body: null, headers: { ETag: tag } };
    }
    return { status: 200, body: envelopeOf(resource).success(output), headers: { ETag: tag } };
  }
  return { status: 200, body: envelopeOf(resource).success(output) };
}

export async function executeUpdate(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const policyCtx = buildPolicyContext(req);
  const lookup = buildLookup(resource, req);
  const patch = await parseBody(await updateSchemaFor(resource, req), req.body);

  // Nested ops envelopes split off the patch and apply inside the SAME
  // transaction, after the parent row is updated.
  const { main: patchMain, nested } = splitNested(patch, nestedUpdateRelations(model));
  const nestedDriver = nested.size > 0 ? requireNestedDriver(resource) : undefined;

  if (
    !config.adapter.capabilities.has('transactions') &&
    config.adapter.capabilities.has('atomicMutations')
  ) {
    if (
      nestedDriver ||
      model.policies?.write ||
      model.policies?.read ||
      model.policies?.readPushdown ||
      model.versioning ||
      model.audit ||
      config.etag ||
      config.hooks?.beforeUpdate ||
      config.hooks?.afterUpdate
    ) {
      throw new CrudException(
        'This update requires callback transactions',
        400,
        'TRANSACTION_UNSUPPORTED',
      );
    }
    const current = await config.adapter.requestScope(
      (scope) => config.adapter.update(lookup, applyManagedUpdateFields(model, patchMain), scope),
      txCtx(req),
    );
    if (!current) throw new NotFoundException(model.name, lookup.value);
    return {
      status: 200,
      body: envelopeOf(resource).success(await shapeOne(resource, policyCtx, req, current)),
    };
  }

  const { prior, current } = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const prior = await config.adapter.readOne(lookup, { forUpdate: config.etag === true }, scope);
    if (!prior) throw new NotFoundException(model.name, lookup.value);
    await assertWriteAllowed(resource, policyCtx, prior);

    // If-Match optimistic concurrency: mismatch is a 409 CONFLICT (hono-crud
    // parity — not 412). An absent header is an unconditional update.
    if (config.etag) {
      const ifMatch = req.request?.headers.get('If-Match');
      if (ifMatch != null && !matchesIfMatch(ifMatch, await etagFor(resource, policyCtx, prior))) {
        throw new ConflictException('Resource has been modified by another request');
      }
    }

    const preparedNested = new Map<string, ReturnType<typeof toNestedOps>>();
    if (nestedDriver) {
      for (const [name, value] of nested) {
        const ops = toNestedOps(value, nestedTargetScope(model, name, req.vars?.tenantId));
        if (ops.create) {
          ops.create = stampNestedCreates(model, name, ops.create, req.vars?.tenantId);
        }
        await assertNestedOperationsAllowed(
          model,
          name,
          policyCtx,
          prior,
          ops,
          nestedDriver,
          scope,
        );
        preparedNested.set(name, ops);
      }
    }

    let managed = applyManagedUpdateFields(model, patchMain);
    // Version snapshot BEFORE the write: captures the pre-update state and
    // stamps the incremented version field onto `managed` (no-op when the
    // model does not version).
    if (config.hooks?.beforeUpdate) {
      managed = (await config.hooks.beforeUpdate(ctx, managed, prior)) ?? managed;
    }

    let current = await config.adapter.update(lookup, managed, scope);
    if (!current) throw new NotFoundException(model.name, lookup.value);

    if (nestedDriver) {
      for (const [name, ops] of preparedNested) {
        await nestedDriver.applyNested(current, name, ops, scope);
      }
    }

    const afterUpdate = config.hooks?.afterUpdate;
    if (afterUpdate) {
      current = await runBeforeChain(
        config.hooks?.afterMode ?? 'sequential',
        [(hookCtx, record) => afterUpdate(hookCtx, prior, record)],
        ctx,
        current,
      );
    }
    return { prior, current };
  }, txCtx(req));

  await captureAudit(resource, req, 'update', {
    recordId: rowIdentifier(resource, current),
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

  if (
    !config.adapter.capabilities.has('transactions') &&
    config.adapter.capabilities.has('atomicMutations')
  ) {
    if (
      model.policies?.write ||
      model.policies?.read ||
      model.policies?.readPushdown ||
      model.versioning ||
      model.audit ||
      config.hooks?.beforeDelete ||
      config.hooks?.afterDelete
    ) {
      throw new CrudException(
        'This delete requires callback transactions',
        400,
        'TRANSACTION_UNSUPPORTED',
      );
    }
    const deleted = await config.adapter.requestScope(
      (scope) => config.adapter.delete(lookup, { softDeleteField: model.softDeleteField }, scope),
      txCtx(req),
    );
    if (!deleted) throw new NotFoundException(model.name, lookup.value);
    return { status: 200, body: envelopeOf(resource).success({ deleted: true }) };
  }

  const prior = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const prior = await config.adapter.readOne(lookup, {}, scope);
    if (!prior) throw new NotFoundException(model.name, lookup.value);
    await assertWriteAllowed(resource, policyCtx, prior);

    // Snapshot the pre-delete state (no-op when the model does not version);
    // no write payload to stamp — the row is being removed.
    if (config.hooks?.beforeDelete) await config.hooks.beforeDelete(ctx, prior);

    const deleted = await config.adapter.delete(
      lookup,
      { softDeleteField: model.softDeleteField },
      scope,
    );
    if (!deleted) throw new NotFoundException(model.name, lookup.value);

    if (config.hooks?.afterDelete) {
      await runHooks(
        config.hooks.afterMode ?? 'sequential',
        [() => config.hooks!.afterDelete!(ctx, prior)],
        [],
      );
    }
    return prior;
  }, txCtx(req));

  await captureAudit(resource, req, 'delete', {
    recordId: rowIdentifier(resource, prior),
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
  const codec = config.pagination?.cursor?.codec;
  let cursorBinding: CursorBinding | undefined;
  if (scoped.options.cursor !== undefined || scoped.options.limit !== undefined) {
    const fields = [
      ...new Set([
        scoped.options.order_by ?? resource.model.primaryKeys[0] ?? 'id',
        ...resource.model.primaryKeys,
      ]),
    ];
    cursorBinding = {
      resource: resource.name,
      ordering: fields.map((field) => ({
        field,
        direction: scoped.options.order_by_direction ?? 'asc',
      })),
      ...(req.vars?.tenantId === undefined ? {} : { tenantId: req.vars.tenantId }),
      parents: Object.fromEntries(
        Object.entries(config.collection?.parents ?? {}).map(([field, param]) => [
          field,
          req.params?.[param] ?? '',
        ]),
      ),
    };
    const keyset = resolveKeyset(
      codec && scoped.options.cursor
        ? await codec.decode(scoped.options.cursor, cursorBinding)
        : scoped.options.cursor,
      fields,
      scoped.options.order_by_direction ?? 'asc',
    );
    if (keyset.after) {
      keyset.after = keyset.after.map((value, index) => {
        const schema = resource.model.schema.shape[fields[index]];
        const parsedValue = schema ? safeParse(schema, value) : undefined;
        if (!parsedValue?.success) throw new InputValidationException('Invalid cursor field value');
        return cursorValue(parsedValue.data);
      });
    }
    scoped.options.keyset = keyset;
    scoped.options.cursor = undefined;
  }

  if (config.hooks?.beforeList) {
    await config.hooks.beforeList(buildHookContext(req, { tx: undefined }));
  }

  const enumerateForReadPolicy = resource.model.policies?.read !== undefined;
  const page = await config.adapter.requestScope(async (scope) => {
    const fetched = enumerateForReadPolicy
      ? {
          result: await listFallbackRows(
            resource,
            {
              filters: scoped.filters,
              options: {
                ...scoped.options,
                page: 1,
                per_page: undefined,
                cursor: undefined,
                keyset: undefined,
                limit: undefined,
              },
            },
            scope,
          ),
          // Replaced with policy-safe metadata after every row is checked.
          result_info: {
            page: 1,
            per_page: scoped.options.per_page ?? 20,
            has_next_page: false,
            has_prev_page: false,
          },
        }
      : await config.adapter.list(scoped, scope);
    await attachIncludes(resource, req, scoped.options.include, fetched.result, scope, {
      withDeleted: scoped.options.withDeleted ?? false,
    });
    return fetched;
  }, txCtx(req));

  // Read policy: silently drop rows the caller may not see.  Arbitrary read
  // predicates cannot be pushed into a generic adapter, so enumerate the
  // bounded source set first and paginate only the authorized rows.  This
  // prevents hidden rows from leaking through total_count/page existence.
  const readable = await filterReadable(policyCtx, page.result, resource.model.policies);
  let visiblePage: Page<Row> = page;
  if (enumerateForReadPolicy) {
    const options = scoped.options;
    if (options.keyset) {
      const ordered = [...readable].sort((a, b) => compareKeysetRows(options.keyset!, a, b));
      const window = ordered.filter((row) => isAfterKeyset(options.keyset!, row));
      visiblePage = buildKeysetPage(
        options.limit ?? options.per_page ?? 20,
        window,
        options.keyset,
        readable.length,
      );
    } else {
      const currentPage = options.page ?? 1;
      const perPage = options.per_page ?? 20;
      const start = (currentPage - 1) * perPage;
      visiblePage = {
        result: readable.slice(start, start + perPage),
        result_info: buildOffsetPageInfo(currentPage, perPage, readable.length),
      };
    }
  } else {
    visiblePage = { ...page, result: readable };
  }

  if (codec && cursorBinding && visiblePage.result_info.next_cursor)
    visiblePage.result_info.next_cursor = await codec.encode(
      visiblePage.result_info.next_cursor,
      cursorBinding,
    );

  let rows = await applyComputedFieldsToArray(
    resource.model,
    await projectPage(resource, req, visiblePage.result),
  );
  rows = rows.map((row) => maskFields(policyCtx, row, resource.model.policies));
  rows = applyProfileToArray(resource.model, rows);
  let output: unknown[] = rows;
  if (config.hooks?.transformList) {
    const ctx = buildHookContext(req, { tx: undefined });
    output = await Promise.all(rows.map((row) => config.hooks!.transformList!(ctx, row)));
  }
  const selection = resolveSelection(resource, req);
  if (selection?.isActive && selection.fields.length > 0)
    output = applyFieldSelectionToArray(output.map(parseRecord), selection);

  if (resource.config.contracts?.response ?? resource.model.contracts?.response)
    output = await Promise.all(
      output.map((value) => responseContract(resource, parseRecord(value))),
    );
  let result: Page<unknown> = { result: output, result_info: visiblePage.result_info };
  if (config.hooks?.afterList) {
    const ctx = buildHookContext(req, { tx: undefined });
    result = (await config.hooks.afterList(ctx, result)) ?? result;
  }

  return {
    status: 200,
    body: envelopeOf(resource).success(result.result, result.result_info),
  };
}

function parseRecord(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('CRUD row transforms must return an object');
  }
  return Object.fromEntries(Object.entries(value));
}
