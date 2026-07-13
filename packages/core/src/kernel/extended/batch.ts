/**
 * Batch family: batchCreate / batchUpdate / batchDelete / batchRestore /
 * batchUpsert + bulkPatch. Executors register in `batchExecutors` and surface
 * through `./registry` — see that file for the composition contract.
 *
 * Pipeline order mirrors the core five (`../verbs.ts`): every adapter call for
 * one request runs inside a SINGLE `config.adapter.transaction()` (the only
 * scope source), managed fields are stamped in the engine, per-item hooks fire
 * with the item's 0-based index, and the read-shaping tail (`shapeOne`:
 * computed → policy mask → field selection) shapes each returned row.
 *
 * Adapter path selection (contract capabilities):
 *  - batchCreate → `createMany` when `nativeBatch` is declared, else per-item
 *    `create` inside the one transaction.
 *  - bulkPatch   → `updateWhere` when `bulkPatch` is declared, else list-match
 *    + per-row `update` inside the one transaction.
 *  - batchRestore→ `restore` (capability-guarded; absent → loud
 *    ConfigurationException — restore cannot be synthesized from the core five).
 *  - batchUpsert → native `upsertOne` when `upsert` is declared, else find +
 *    update-with-restore / create per item.
 *
 * Parity sources (hono-crud 0.13):
 *  - endpoints/batch-{create,update,delete,restore,upsert}.ts + bulk-patch.ts
 *  - packages/memory/src/batch.ts (+ helpers `findByUpsertKeys`)
 *  - tests/batch-upsert.test.ts, tests/conformance/cells/{bulk-patch,
 *    batch-tenant-scoping}.ts
 *
 * DELIBERATE DIVERGENCES (parity ledger):
 *  - bulkPatch filters arrive in the REQUEST BODY (`{ filter, data }`) rather
 *    than the query string (hono-crud). The success body stays flat
 *    (`{ success, matched, updated, dryRun, records? }`) exactly like hono-crud.
 *  - The id-keyed batch verbs apply TENANT scoping (like the single verbs) but
 *    NOT per-row policy pushdown; bulkPatch applies tenant + policy pushdown.
 *  - Per-item hook errors follow the hook mode (sequential throws/aborts,
 *    fire-and-forget swallows) instead of hono-crud's per-item error bucket +
 *    `stopOnError`; only `notFound` ids drive the 207 status.
 *  - batchRestore requires the model to soft-delete AND the adapter to declare
 *    `restore` — both absent cases are a loud 500 ConfigurationException
 *    (matching the single restore verb) rather than hono-crud's 400
 *    SOFT_DELETE_NOT_ENABLED.
 */

import type { FilterCondition, ListQuery, Lookup } from '../../adapter/query-types';
import {
  ConfigurationException,
  CrudException,
  InputValidationException,
  NotFoundException,
} from '../../envelope/errors';
import {
  applyManagedInsertFields,
  applyManagedUpdateFields,
  stripPrimaryKeys,
} from '../../model/managed-fields';
import { assertNoNestedWrites } from '../nested-writes';
import {
  applyUpsertRestore,
  isSoftDeleted,
  softDeleteVisibilityFilter,
} from '../../model/soft-delete';
import { parseListFilters } from '../../query/filters';
import type { CrudEndpointName } from '../../verb-table';
import type { EngineRequest, EngineResult } from '../engine-request';
import type { HookContext, HookMode } from '../hook-types';
import { captureAuditBatch } from '../capture';
import { envelopeOf } from '../resource';
import { runBeforeChain } from '../run-hooks';
import {
  buildHookContext,
  buildPolicyContext,
  listParseOptions,
  createSchemaFor,
  parseBody,
  updateSchemaFor,
  scopeListQuery,
  shapeOne,
  tenantFilters,
  txCtx,
  type AnyResource,
} from '../verb-helpers';
import type { VerbExecutor } from './registry';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** hono-crud's `maxBatchSize` default (per-request item cap for the id/array batch verbs). */
const DEFAULT_MAX_BATCH_SIZE = 100;
/** hono-crud's `maxBulkSize` default (row cap for a single filtered bulk patch). */
const DEFAULT_MAX_BULK_SIZE = 1000;
/** hono-crud's `confirmThreshold` default (rows at/above which X-Confirm-Bulk is required). */
const DEFAULT_CONFIRM_THRESHOLD = 100;

function maxBatchSize(resource: AnyResource): number {
  return resource.config.batch?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
}

function primaryKey(resource: AnyResource): string {
  return resource.model.primaryKeys[0] ?? 'id';
}

/** A tenant-scoped point lookup for a client-supplied id. */
function lookupFor(resource: AnyResource, req: EngineRequest, id: string): Lookup {
  return { field: primaryKey(resource), value: id, filters: tenantFilters(resource, req) };
}

/**
 * The id-keyed batch verbs operate on a client-supplied id list, so — unlike
 * the single verbs, whose tenant filter comes from core-injected lookup
 * filters — they must reject a missing tenant loudly (hono-crud
 * `validateTenantId` + the batch-tenant-scoping cell's TENANT_REQUIRED test).
 */
function requireTenant(resource: AnyResource, req: EngineRequest): void {
  if (resource.model.tenantField !== undefined && req.vars?.tenantId === undefined) {
    throw new CrudException('This operation requires a tenant context', 400, 'TENANT_REQUIRED');
  }
}

/** `{ items: [...] }` body → the items array (loud on the wrong shape). */
function extractItems(body: unknown): unknown[] {
  const items = (body as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) {
    throw new InputValidationException('Request body must include an "items" array');
  }
  return items;
}

/** `{ ids: [...] }` body → the string-id array (loud on the wrong shape). */
function extractIds(body: unknown): string[] {
  const ids = (body as { ids?: unknown } | null | undefined)?.ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new InputValidationException('Request body must include an "ids" array of strings');
  }
  return ids as string[];
}

/** Bare-array body (batchUpsert) → the items array (loud on the wrong shape). */
function extractArray(body: unknown): unknown[] {
  if (!Array.isArray(body)) {
    throw new InputValidationException('Request body must be an array of items');
  }
  return body;
}

interface UpdateItem {
  id: string;
  data: Row;
}

/** `{ items: [{ id, data }] }` body → validated `{ id, data }` pairs. */
function extractUpdateItems(body: unknown): UpdateItem[] {
  return extractItems(body).map((raw, index) => {
    const item = raw as { id?: unknown; data?: unknown } | null | undefined;
    if (typeof item?.id !== 'string' || item.id === '') {
      throw new InputValidationException(
        `Batch update item at index ${index} is missing a string "id"`,
      );
    }
    const data = item.data;
    if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
      throw new InputValidationException(
        `Batch update item at index ${index} has a non-object "data"`,
      );
    }
    return { id: item.id, data: (data ?? {}) as Row };
  });
}

/** Enforce `1..max` (hono-crud's `z.array(...).min(1).max(maxBatchSize)`). */
function assertBatchSize(count: number, max: number): void {
  if (count < 1) {
    throw new InputValidationException('Batch must include at least one item');
  }
  if (count > max) {
    throw new InputValidationException(`Batch size ${count} exceeds the maximum of ${max}`);
  }
}

/**
 * Run one per-item hook honoring `mode` (single-hook `runBeforeChain`):
 *  - `sequential` — await, thread the returned replacement (if any);
 *  - `parallel` — await, IGNORE the return (keep the original item);
 *  - `fire-and-forget` — do not await, swallow failures (keep the original).
 *
 * Works for both replacing hooks (create/update/restore/upsert `BatchMutator`)
 * and observe-only ones (delete/restore `void` hooks — their `undefined` return
 * leaves the value unchanged).
 */
async function runItemHook<V>(
  mode: HookMode,
  hook: ((ctx: HookContext, item: V, index: number) => unknown) | undefined,
  ctx: HookContext,
  item: V,
  index: number,
): Promise<V> {
  if (!hook) return item;
  const result = await runBeforeChain(mode, [(c, d) => hook(c, d as V, index)], ctx, item);
  return result as V;
}

/**
 * Build the id-keyed batch success envelope: `{ [key]: rows, count, notFound? }`
 * → 207 when any id fell through to `notFound`, else 200 (hono-crud
 * `finalizeBatchResponse`).
 */
function batchResult(
  resource: AnyResource,
  key: 'updated' | 'deleted' | 'restored',
  rows: Row[],
  notFound: string[],
): EngineResult {
  const result: Record<string, unknown> = { [key]: rows, count: rows.length };
  if (notFound.length > 0) result.notFound = notFound;
  const status = notFound.length > 0 ? 207 : 200;
  return { status, body: envelopeOf(resource).success(result) };
}

/** Tenant-scoped, soft-delete-INCLUSIVE find query for the upsert conflict keys. */
function buildUpsertFindQuery(
  resource: AnyResource,
  req: EngineRequest,
  keys: string[],
  values: Row,
): ListQuery {
  const filters: FilterCondition[] = keys.map((key) => ({
    field: key,
    operator: 'eq',
    value: values[key],
  }));
  const tenantField = resource.model.tenantField;
  if (tenantField !== undefined && req.vars?.tenantId !== undefined) {
    filters.push({ field: tenantField, operator: 'eq', value: req.vars.tenantId });
  }
  // Match-and-restore: upsert MATCHES soft-deleted rows and restores them rather
  // than duplicating (single-upsert parity + `upsert-restore` cell).
  return { filters, options: { withDeleted: true, page: 1, per_page: 1 } };
}

/** `?dryRun=true|1` on the bulk-patch request. */
function isDryRun(req: EngineRequest): boolean {
  const raw = req.query?.dryRun;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'true' || value === '1';
}

// ---------------------------------------------------------------------------
// batchCreate — POST /batch   body: { items: Item[] }
// ---------------------------------------------------------------------------

/**
 * Insert many rows atomically. Each item validates against the create schema,
 * gets the tenant stamp + managed insert fields (fresh PK + timestamps), then
 * `beforeBatchCreate(item, index)`. Writes go through `createMany` (native
 * batch) or per-item `create`, then `afterBatchCreate(row, index)`. 201 with
 * `{ created, count }`.
 *
 * All-or-nothing: validation / hooks throw and roll back the single
 * transaction (hono-crud's default `stopOnError: true` — no partial `errors`).
 */
async function executeBatchCreate(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const rawItems = extractItems(req.body);
  assertBatchSize(rawItems.length, maxBatchSize(resource));

  const beforeMode = config.hooks?.modes?.batchCreate?.beforeMode ?? 'sequential';
  const afterMode = config.hooks?.modes?.batchCreate?.afterMode ?? 'sequential';
  const databaseGeneratedId = config.adapter.capabilities.has('databaseGeneratedId');
  const createMany = config.adapter.createMany;
  const createSchema = await createSchemaFor(resource, req);

  const created = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);

    // Validate + stamp every item first (all-or-nothing: an invalid item aborts
    // before any before-hook runs or any row is written).
    const prepared: Row[] = rawItems.map((item) => {
      const data = parseBody(createSchema, item);
      assertNoNestedWrites(model, data, 'batchCreate');
      if (model.tenantField !== undefined && req.vars?.tenantId !== undefined) {
        data[model.tenantField] = req.vars.tenantId;
      }
      return applyManagedInsertFields(model, data, { databaseGeneratedId });
    });

    const inputs: Row[] = [];
    for (let i = 0; i < prepared.length; i++) {
      inputs.push(
        await runItemHook(beforeMode, config.hooks?.beforeBatchCreate, ctx, prepared[i], i),
      );
    }

    const rows: Row[] = [];
    if (config.adapter.capabilities.has('nativeBatch') && createMany) {
      rows.push(...((await createMany(inputs, scope)) as Row[]));
    } else {
      for (const input of inputs) rows.push((await config.adapter.create(input, scope)) as Row);
    }

    const out: Row[] = [];
    for (let i = 0; i < rows.length; i++) {
      out.push(await runItemHook(afterMode, config.hooks?.afterBatchCreate, ctx, rows[i], i));
    }
    return out;
  }, txCtx(req));

  await captureAuditBatch(
    resource,
    req,
    'batch_create',
    created.map((row) => ({ recordId: row[primaryKey(resource)] as string | number, record: row })),
  );

  const policyCtx = buildPolicyContext(req);
  const shaped = await Promise.all(created.map((row) => shapeOne(resource, policyCtx, req, row)));
  return {
    status: 201,
    body: envelopeOf(resource).success({ created: shaped, count: shaped.length }),
  };
}

// ---------------------------------------------------------------------------
// batchUpdate — PATCH /batch   body: { items: [{ id, data }] }
// ---------------------------------------------------------------------------

/**
 * Patch many rows by id. Every item's `data` validates against the update
 * schema up front (all-or-nothing validation). Per item: read the tenant-scoped
 * prior (missing → `notFound`), `beforeBatchUpdate(patch, index)`, `update`,
 * `afterBatchUpdate(row, index)`. 200, or 207 when any id was not found.
 */
async function executeBatchUpdate(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  requireTenant(resource, req);
  const items = extractUpdateItems(req.body);
  assertBatchSize(items.length, maxBatchSize(resource));

  const beforeMode = config.hooks?.modes?.batchUpdate?.beforeMode ?? 'sequential';
  const afterMode = config.hooks?.modes?.batchUpdate?.afterMode ?? 'sequential';

  const updateSchema = await updateSchemaFor(resource, req);
  const outcome = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const patches = items.map((item) => {
      const parsed = parseBody(updateSchema, item.data);
      assertNoNestedWrites(model, parsed, 'batchUpdate');
      return applyManagedUpdateFields(model, parsed);
    });

    const updated: Row[] = [];
    const notFound: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const lookup = lookupFor(resource, req, items[i].id);
      const prior = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
      if (!prior) {
        notFound.push(items[i].id);
        continue;
      }
      const patch = await runItemHook(
        beforeMode,
        config.hooks?.beforeBatchUpdate,
        ctx,
        patches[i],
        i,
      );
      const current = (await config.adapter.update(lookup, patch, scope)) as Row | null;
      if (!current) {
        notFound.push(items[i].id);
        continue;
      }
      updated.push(await runItemHook(afterMode, config.hooks?.afterBatchUpdate, ctx, current, i));
    }
    return { updated, notFound };
  }, txCtx(req));

  await captureAuditBatch(
    resource,
    req,
    'batch_update',
    outcome.updated.map((row) => ({
      recordId: row[primaryKey(resource)] as string | number,
      record: row,
    })),
  );

  const policyCtx = buildPolicyContext(req);
  const shaped = await Promise.all(
    outcome.updated.map((row) => shapeOne(resource, policyCtx, req, row)),
  );
  return batchResult(resource, 'updated', shaped, outcome.notFound);
}

// ---------------------------------------------------------------------------
// batchDelete — DELETE /batch   body: { ids: string[] }
// ---------------------------------------------------------------------------

/**
 * Delete many rows by id (soft-delete stamp when the model soft-deletes, else
 * hard delete). Per id: read the tenant-scoped prior (missing / already deleted
 * → `notFound`), `beforeBatchDelete(prior, index)`, `delete`,
 * `afterBatchDelete(prior, index)`. The removed rows come back in `deleted`.
 * 200, or 207 when any id was not found.
 */
async function executeBatchDelete(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  requireTenant(resource, req);
  const ids = extractIds(req.body);
  assertBatchSize(ids.length, maxBatchSize(resource));

  const beforeMode = config.hooks?.modes?.batchDelete?.beforeMode ?? 'sequential';
  const afterMode = config.hooks?.modes?.batchDelete?.afterMode ?? 'sequential';

  const outcome = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const deleted: Row[] = [];
    const notFound: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const lookup = lookupFor(resource, req, ids[i]);
      const prior = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
      if (!prior) {
        notFound.push(ids[i]);
        continue;
      }
      await runItemHook(beforeMode, config.hooks?.beforeBatchDelete, ctx, prior, i);
      const removed = (await config.adapter.delete(
        lookup,
        { softDeleteField: model.softDeleteField },
        scope,
      )) as Row | null;
      if (!removed) {
        notFound.push(ids[i]);
        continue;
      }
      await runItemHook(afterMode, config.hooks?.afterBatchDelete, ctx, prior, i);
      deleted.push(removed);
    }
    return { deleted, notFound };
  }, txCtx(req));

  await captureAuditBatch(
    resource,
    req,
    'batch_delete',
    outcome.deleted.map((row) => ({
      recordId: row[primaryKey(resource)] as string | number,
      previousRecord: row,
    })),
  );

  const policyCtx = buildPolicyContext(req);
  const shaped = await Promise.all(
    outcome.deleted.map((row) => shapeOne(resource, policyCtx, req, row)),
  );
  return batchResult(resource, 'deleted', shaped, outcome.notFound);
}

// ---------------------------------------------------------------------------
// batchRestore — POST /batch/restore   body: { ids: string[] }
// ---------------------------------------------------------------------------

/**
 * Un-delete many soft-deleted rows by id via the adapter's `restore`. Per id:
 * read the tenant-scoped, soft-delete-inclusive prior (missing / not deleted →
 * `notFound`), `beforeBatchRestore(prior, index)`, `restore`,
 * `afterBatchRestore(row, index)`. 200, or 207 when any id was not found.
 *
 * Loud config guards (single-restore parity): the model must soft-delete AND
 * the adapter must declare `restore` — restore has no core-five synthesis.
 */
async function executeBatchRestore(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;

  if (model.softDeleteField === undefined) {
    throw new ConfigurationException(
      `Resource '${model.name}': batchRestore requires soft-delete to be enabled on the model`,
    );
  }
  if (!config.adapter.capabilities.has('restore') || config.adapter.restore === undefined) {
    throw new ConfigurationException(
      `Resource '${model.name}': batchRestore requires an adapter with the 'restore' capability`,
    );
  }
  const restore = config.adapter.restore;

  requireTenant(resource, req);
  const ids = extractIds(req.body);
  assertBatchSize(ids.length, maxBatchSize(resource));

  const beforeMode = config.hooks?.modes?.batchRestore?.beforeMode ?? 'sequential';
  const afterMode = config.hooks?.modes?.batchRestore?.afterMode ?? 'sequential';

  const outcome = await config.adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const restored: Row[] = [];
    const notFound: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const lookup = lookupFor(resource, req, ids[i]);
      const prior = (await config.adapter.readOne(
        lookup,
        { withDeleted: true },
        scope,
      )) as Row | null;
      if (!prior || !isSoftDeleted(model, prior)) {
        notFound.push(ids[i]);
        continue;
      }
      await runItemHook(beforeMode, config.hooks?.beforeBatchRestore, ctx, prior, i);
      const row = (await restore(lookup, scope)) as Row | null;
      if (!row) {
        notFound.push(ids[i]);
        continue;
      }
      restored.push(await runItemHook(afterMode, config.hooks?.afterBatchRestore, ctx, row, i));
    }
    return { restored, notFound };
  }, txCtx(req));

  await captureAuditBatch(
    resource,
    req,
    'batch_restore',
    outcome.restored.map((row) => ({
      recordId: row[primaryKey(resource)] as string | number,
      record: row,
    })),
  );

  const policyCtx = buildPolicyContext(req);
  const shaped = await Promise.all(
    outcome.restored.map((row) => shapeOne(resource, policyCtx, req, row)),
  );
  return batchResult(resource, 'restored', shaped, outcome.notFound);
}

// ---------------------------------------------------------------------------
// batchUpsert — POST /batch/upsert   body: Item[]  (bare array)
// ---------------------------------------------------------------------------

/**
 * Create-or-update many rows by the configured conflict keys. Per item: find
 * the tenant-scoped, soft-delete-inclusive existing row, `beforeBatchUpsert`,
 * then the native `upsertOne` path or the synthesis update-with-restore /
 * create path, then `afterBatchUpsert`. 200 with
 * `{ items: [{ data, created, index }], createdCount, updatedCount, totalCount }`.
 *
 * `upsert.keys` is REQUIRED (loud ConfigurationException). Empty body array is
 * valid (→ empty result); only the max size is enforced (hono-crud has no min).
 */
async function executeBatchUpsert(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const adapter = config.adapter;
  const caps = adapter.capabilities;

  const keys = config.upsert?.keys;
  if (!keys || keys.length === 0) {
    throw new ConfigurationException(
      `Resource '${model.name}': batchUpsert requires 'upsert.keys' to be configured`,
    );
  }

  const rawItems = extractArray(req.body);
  const max = maxBatchSize(resource);
  if (rawItems.length > max) {
    throw new InputValidationException(
      `Batch size ${rawItems.length} exceeds the maximum of ${max}`,
    );
  }

  const beforeMode = config.hooks?.modes?.batchUpsert?.beforeMode ?? 'sequential';
  const afterMode = config.hooks?.modes?.batchUpsert?.afterMode ?? 'sequential';
  const databaseGeneratedId = caps.has('databaseGeneratedId');
  const pk = primaryKey(resource);
  const upsertOne = adapter.upsertOne;

  const upsertCreateSchema = await createSchemaFor(resource, req);
  const outcome = await adapter.transaction(async (scope) => {
    const ctx = buildHookContext(req, scope);
    const items: Array<{ record: Row; created: boolean; index: number }> = [];
    let createdCount = 0;
    let updatedCount = 0;

    for (let i = 0; i < rawItems.length; i++) {
      const values = parseBody(upsertCreateSchema, rawItems[i]);
      assertNoNestedWrites(model, values, 'batchUpsert');
      if (model.tenantField !== undefined && req.vars?.tenantId !== undefined) {
        values[model.tenantField] = req.vars.tenantId;
      }

      const found = (await adapter.list(buildUpsertFindQuery(resource, req, keys, values), scope))
        .result[0] as Row | undefined;
      const existing = found ?? null;

      const data = await runItemHook(beforeMode, config.hooks?.beforeBatchUpsert, ctx, values, i);

      let record: Row;
      let created: boolean;

      if (caps.has('upsert') && upsertOne) {
        const managed = applyManagedInsertFields(model, data, { databaseGeneratedId });
        const conflictValues =
          existing !== null ? (applyUpsertRestore(model, managed, existing) as Row) : managed;
        const res = await upsertOne({ conflictTarget: keys, values: conflictValues }, scope);
        record = res.row as Row;
        created = res.created;
      } else if (existing !== null) {
        const existingLookup: Lookup = {
          field: pk,
          value: String(existing[pk]),
          filters: tenantFilters(resource, req),
        };
        if (isSoftDeleted(model, existing)) {
          const restore = adapter.restore;
          if (!caps.has('restore') || restore === undefined) {
            throw new ConfigurationException(
              `Resource '${model.name}': batchUpsert match-and-restore of a soft-deleted row ` +
                `requires an adapter with the 'restore' capability`,
            );
          }
          await restore(existingLookup, scope);
        }
        // Body PK (present under id:'client') is insert-leg identity only.
        const patch = applyUpsertRestore(
          model,
          applyManagedUpdateFields(model, stripPrimaryKeys(model, data)),
          existing,
        ) as Row;
        const updated = (await adapter.update(existingLookup, patch, scope)) as Row | null;
        if (!updated) throw new NotFoundException(model.name, existingLookup.value);
        record = updated;
        created = false;
      } else {
        const managed = applyManagedInsertFields(model, data, { databaseGeneratedId });
        record = (await adapter.create(managed, scope)) as Row;
        created = true;
      }

      record = await runItemHook(afterMode, config.hooks?.afterBatchUpsert, ctx, record, i);
      items.push({ record, created, index: i });
      if (created) createdCount++;
      else updatedCount++;
    }

    return { items, createdCount, updatedCount };
  }, txCtx(req));

  await captureAuditBatch(
    resource,
    req,
    'batch_upsert',
    outcome.items.map((item) => ({
      recordId: item.record[primaryKey(resource)] as string | number,
      record: item.record,
    })),
  );

  const policyCtx = buildPolicyContext(req);
  const items = await Promise.all(
    outcome.items.map(async (item) => ({
      data: await shapeOne(resource, policyCtx, req, item.record),
      created: item.created,
      index: item.index,
    })),
  );
  return {
    status: 200,
    body: envelopeOf(resource).success({
      items,
      createdCount: outcome.createdCount,
      updatedCount: outcome.updatedCount,
      totalCount: items.length,
    }),
  };
}

// ---------------------------------------------------------------------------
// bulkPatch — PATCH /bulk   body: { filter?, data }
// ---------------------------------------------------------------------------

/**
 * Patch every row matching a filter set. `data` validates against the update
 * schema (empty → EMPTY_BODY). `filter` is parsed with the SAME allow-lists as
 * list (`filterFields`/`filterConfig`), then tenant scope + policy pushdown are
 * merged in. Soft-deleted rows are never matched or patched.
 *
 * Guards, in hono-crud order: `matched === 0` → early return; `matched >
 * maxBulkSize` → BULK_TOO_LARGE; `matched >= confirmThreshold` without
 * `X-Confirm-Bulk: true` → CONFIRMATION_REQUIRED; `?dryRun=true` → count only.
 * Writes go through `updateWhere` (native bulk) or list-match + per-row `update`.
 *
 * Flat success body (NOT the resource envelope, matching hono-crud + the cell):
 * `{ success, matched, updated, dryRun, records? }`.
 */
async function executeBulkPatch(resource: AnyResource, req: EngineRequest): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const adapter = config.adapter;
  const policyCtx = buildPolicyContext(req);

  const maxBulkSize = config.bulkPatch?.maxBulkSize ?? DEFAULT_MAX_BULK_SIZE;
  const confirmThreshold = config.bulkPatch?.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD;
  const returnRecords = config.bulkPatch?.returnRecords ?? false;

  const body = (req.body ?? {}) as {
    filter?: Record<string, string | string[]>;
    data?: unknown;
  };
  const rawData = body.data;
  if (
    typeof rawData !== 'object' ||
    rawData === null ||
    Array.isArray(rawData) ||
    Object.keys(rawData).length === 0
  ) {
    throw new CrudException(
      'Bulk patch requires a non-empty "data" object with at least one field to update',
      400,
      'EMPTY_BODY',
    );
  }
  const patchFields = parseBody(await updateSchemaFor(resource, req), rawData);
  assertNoNestedWrites(model, patchFields, 'bulkPatch');
  const dryRun = isDryRun(req);

  // Parse + scope the body filters exactly like list (allow-listed fields /
  // operators, tenant scope, policy pushdown). Soft-delete exclusion comes from
  // the list options (default) / the explicit visibility filter (updateWhere).
  const parsed = parseListFilters(body.filter ?? {}, listParseOptions(resource));
  const scoped = scopeListQuery(resource, req, policyCtx, parsed);
  const countQuery: ListQuery = {
    filters: scoped.filters,
    options: { ...scoped.options, page: 1, per_page: maxBulkSize },
  };
  const txContext = txCtx(req);

  const matched = await adapter.transaction(async (scope) => {
    const page = await adapter.list(countQuery, scope);
    return page.result_info.total_count ?? page.result.length;
  }, txContext);

  if (matched === 0) {
    return { status: 200, body: { success: true, matched: 0, updated: 0, dryRun } };
  }
  if (matched > maxBulkSize) {
    throw new CrudException(
      `Bulk patch affects ${matched} records, exceeding the maximum of ${maxBulkSize}. ` +
        'Use more specific filters.',
      400,
      'BULK_TOO_LARGE',
    );
  }
  if (matched >= confirmThreshold) {
    const confirm = req.request?.headers.get('X-Confirm-Bulk');
    if (confirm !== 'true') {
      throw new CrudException(
        `This operation will affect ${matched} records. Set X-Confirm-Bulk: true to confirm.`,
        400,
        'CONFIRMATION_REQUIRED',
      );
    }
  }
  if (dryRun) {
    return { status: 200, body: { success: true, matched, updated: 0, dryRun: true } };
  }

  const patch = applyManagedUpdateFields(model, patchFields);
  const updateWhere = adapter.updateWhere;

  const result = await adapter.transaction(async (scope) => {
    if (adapter.capabilities.has('bulkPatch') && updateWhere) {
      const filters = [...scoped.filters];
      const visibility = softDeleteVisibilityFilter(model);
      if (visibility) filters.push(visibility);
      const out = await updateWhere(filters, patch, scope);
      return { updated: out.count, records: out.records as Row[] | undefined };
    }
    // Synthesis: re-list the visible matched rows and patch each by PK.
    const page = await adapter.list(countQuery, scope);
    const records: Row[] = [];
    for (const row of page.result as Row[]) {
      const lookup: Lookup = {
        field: primaryKey(resource),
        value: String(row[primaryKey(resource)]),
        filters: tenantFilters(resource, req),
      };
      const updated = (await adapter.update(lookup, patch, scope)) as Row | null;
      if (updated) records.push(updated);
    }
    return { updated: records.length, records };
  }, txContext);

  const response: Record<string, unknown> = {
    success: true,
    matched,
    updated: result.updated,
    dryRun: false,
  };
  if (returnRecords && result.records) {
    response.records = await Promise.all(
      result.records.map((row) => shapeOne(resource, policyCtx, req, row)),
    );
  }
  return { status: 200, body: response };
}

// ---------------------------------------------------------------------------

export const batchExecutors: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  batchCreate: executeBatchCreate,
  batchUpdate: executeBatchUpdate,
  batchDelete: executeBatchDelete,
  batchRestore: executeBatchRestore,
  batchUpsert: executeBatchUpsert,
  bulkPatch: executeBulkPatch,
};
