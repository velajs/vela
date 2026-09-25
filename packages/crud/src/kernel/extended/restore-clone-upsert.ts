import { lookupFromRow, rowIdentifier } from '../verb-helpers';
import { deriveCreateSchema } from '../../model/schema-derive';
/**
 * Point-verb family: restore, clone, upsert. Executors register here and
 * surface through `./registry` — see that file for the composition contract.
 *
 * Pipeline order mirrors the core five in `../verbs.ts`: every adapter call
 * runs inside `config.adapter.transaction()` (the only scope source), managed
 * fields are stamped in the engine, and the read-shaping tail (`shapeOne`:
 * computed → policy mask → field selection) shapes the returned row.
 *
 * Parity sources (hono-crud 0.13):
 *  - restore → `endpoints/restore.ts` + memory `MemoryRestoreEndpoint`
 *    (crud.ts) + conformance `soft-delete-lifecycle` cell.
 *  - clone   → `endpoints/clone.ts` + memory `MemoryCloneEndpoint`
 *    (advanced.ts).
 *  - upsert  → `endpoints/upsert.ts` + `tests/upsert.test.ts` + conformance
 *    `upsert-restore` cell (match-and-restore).
 */

import type { FilterCondition, ListQuery } from '../../adapter/query-types';
import { ConfigurationException, CrudException, NotFoundException } from '../../envelope/errors';
import {
  applyManagedInsertFields,
  applyManagedUpdateFields,
  stripPrimaryKeys,
} from '../../model/managed-fields';
import { assertNoNestedWrites } from '../nested-writes';
import { applyUpsertRestore, isSoftDeleted } from '../../model/soft-delete';
import type { CrudEndpointName } from '../../verb-table';
import { captureAudit } from '../capture';
import type { EngineRequest, EngineResult } from '../engine-request';
import { envelopeOf } from '../resource';
import {
  assertCreateAllowed,
  assertReadAllowed,
  assertWriteAllowed,
  buildHookContext,
  buildLookup,
  buildPolicyContext,
  createSchemaFor,
  parseBody,
  shapeOne,
  txCtx,
  type AnyResource,
} from '../verb-helpers';
import type { VerbExecutor } from './registry';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// restore — POST /:id/restore
// ---------------------------------------------------------------------------

/**
 * Un-delete a soft-deleted record. 200 with the restored record envelope.
 *
 * 404 (NOT_FOUND) when the id is missing OR the row is not currently
 * soft-deleted — `adapter.restore` returns `null` for both (MemoryRestore
 * parity + `soft-delete-lifecycle` cell's "restore of a not-deleted record →
 * 404" / "restore of a missing id → 404").
 *
 * No single-restore hooks exist on the hook surface (only the batch-family
 * `beforeBatchRestore`/`afterBatchRestore`), so single restore runs WITHOUT
 * hooks — a deliberate, tracked parity note.
 */
async function executeRestore(resource: AnyResource, req: EngineRequest): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;

  // Loud, never silent: restore is meaningless without soft-delete on the
  // model (the route is gated behind it, but engine-level callers are not).
  if (model.softDeleteField === undefined) {
    throw new ConfigurationException(
      `Resource '${model.name}': restore requires soft-delete to be enabled on the model`,
    );
  }
  // Restore has no core-five synthesis (see contract's 'restore' capability):
  // demand the adapter method rather than silently 404.
  if (!config.adapter.capabilities.has('restore') || config.adapter.restore === undefined) {
    throw new ConfigurationException(
      `Resource '${model.name}': restore requires an adapter with the 'restore' capability`,
    );
  }

  const policyCtx = buildPolicyContext(req);
  const lookup = buildLookup(resource, req);

  const restored = await config.adapter.transaction(async (scope) => {
    const prior = (await config.adapter.readOne(
      lookup,
      { withDeleted: true },
      scope,
    )) as Row | null;
    if (!prior || !isSoftDeleted(model, prior)) {
      throw new NotFoundException(model.name, lookup.value);
    }
    await assertWriteAllowed(resource, policyCtx, prior);
    return config.adapter.restore!(lookup, scope);
  }, txCtx(req));
  if (!restored) throw new NotFoundException(model.name, lookup.value);

  await captureAudit(resource, req, 'restore', {
    recordId: rowIdentifier(resource, restored),
    record: restored as Row,
  });

  const shaped = await shapeOne(resource, policyCtx, req, restored as Row);
  return { status: 200, body: envelopeOf(resource).success(shaped) };
}

// ---------------------------------------------------------------------------
// clone — POST /:id/clone
// ---------------------------------------------------------------------------

/**
 * Duplicate a record: read the source (404 if missing / soft-deleted), strip
 * the engine-managed insert fields (PKs + timestamps) so they regenerate,
 * clear any configured `clone.fieldsToReset`, merge optional body overrides
 * (validated against a PARTIAL create schema), then insert a fresh row. 201
 * with the created-clone envelope (hono-crud `clone.ts`: `success(result, 201)`).
 *
 * No clone-specific hooks exist on the hook surface, and clone does NOT reuse
 * create's hooks (hono-crud's `CloneEndpoint` has its own before/after and does
 * not call create's) — single clone runs WITHOUT hooks (tracked parity note).
 */
async function executeClone(resource: AnyResource, req: EngineRequest): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const policyCtx = buildPolicyContext(req);
  const lookup = buildLookup(resource, req);

  // Overrides validate against the create schema made fully optional — the
  // create schema already excludes engine-managed fields (PKs/timestamps/tenant).
  const overrideSchema =
    resource.config.contracts?.clone ??
    resource.model.contracts?.clone ??
    (resource.config.dto?.create ?? deriveCreateSchema(model)).partial();
  const overrides = await parseBody(overrideSchema, req.body);
  assertNoNestedWrites(model, overrides, 'clone');
  const fieldsToReset = config.clone?.fieldsToReset ?? [];
  const databaseGeneratedId = config.adapter.capabilities.has('databaseGeneratedId');

  const created = await config.adapter.transaction(async (scope) => {
    const source = (await config.adapter.readOne(lookup, {}, scope)) as Row | null;
    if (!source) throw new NotFoundException(model.name, lookup.value);
    await assertReadAllowed(resource, policyCtx, source, lookup.value);

    // Build clone data: source minus managed insert fields (fresh PK + fresh
    // timestamps are stamped below), minus fieldsToReset, plus overrides.
    const cloneData: Row = { ...source };
    for (const pk of model.primaryKeys) delete cloneData[pk];
    if (model.timestamps.createdAt) delete cloneData[model.timestamps.createdAt];
    if (model.timestamps.updatedAt) delete cloneData[model.timestamps.updatedAt];
    for (const field of fieldsToReset) delete cloneData[field];
    Object.assign(cloneData, overrides);
    if (model.tenantField !== undefined && req.vars?.tenantId !== undefined) {
      cloneData[model.tenantField] = req.vars.tenantId;
    }

    const managed = applyManagedInsertFields(model, cloneData, {
      databaseGeneratedId,
      tenantId: req.vars?.tenantId,
    });
    await assertCreateAllowed(resource, policyCtx, managed);
    return (await config.adapter.create(managed, scope)) as Row;
  }, txCtx(req));

  const shaped = await shapeOne(resource, policyCtx, req, created);
  return { status: 201, body: envelopeOf(resource).success(shaped) };
}

// ---------------------------------------------------------------------------
// upsert — POST /upsert
// ---------------------------------------------------------------------------

/** Build the tenant-scoped, soft-delete-INCLUSIVE find query for the keys. */
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
  // withDeleted: hono-crud upsert MATCHES soft-deleted rows and restores them
  // ("match-and-restore") rather than duplicating (upsert.ts findExisting
  // contract + `upsert-restore` cell).
  return { filters, options: { withDeleted: true, page: 1, per_page: 1 } };
}

/**
 * Create-or-update by the configured conflict keys. 201 + `created: true` on
 * insert, 200 + `created: false` on update (hono-crud `upsert.ts` / upsert.test).
 * Envelope is the resource envelope's success body plus a sibling `created`
 * flag: `{ success, result, created }` on the default envelope.
 *
 * `config.upsert.keys` is REQUIRED — its absence is a loud ConfigurationException.
 *
 * Native path: when the adapter declares `upsert`, delegate to `upsertOne`
 * (its returned `created` is authoritative). Synthesis path: find existing by
 * keys (matching soft-deleted rows), then update-with-restore or create, all
 * inside the transaction.
 */
async function executeUpsert(resource: AnyResource, req: EngineRequest): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const adapter = config.adapter;
  const caps = adapter.capabilities;
  const policyCtx = buildPolicyContext(req);

  const keys = config.upsert?.keys;
  if (!keys || keys.length === 0) {
    throw new ConfigurationException(
      `Resource '${model.name}': upsert requires 'upsert.keys' to be configured`,
    );
  }

  const values = await parseBody(
    config.contracts?.upsert ?? model.contracts?.upsert ?? (await createSchemaFor(resource, req)),
    req.body,
  );
  assertNoNestedWrites(model, values, 'upsert');
  // Tenant is injected before find + before-hook so a created row is scoped and
  // the find never crosses tenants (hono-crud injects tenant pre-find).
  if (model.tenantField !== undefined && req.vars?.tenantId !== undefined) {
    values[model.tenantField] = req.vars.tenantId;
  }
  const databaseGeneratedId = caps.has('databaseGeneratedId');

  if (!caps.has('transactions') && caps.has('scopedUpsert') && adapter.upsertOne) {
    if (
      config.hooks?.beforeUpsert ||
      config.hooks?.afterUpsert ||
      model.policies?.read ||
      model.policies?.readPushdown ||
      model.policies?.write ||
      model.versioning ||
      model.audit ||
      model.softDeleteField
    ) {
      throw new CrudException(
        'This upsert requires callback transactions',
        400,
        'TRANSACTION_UNSUPPORTED',
      );
    }
    const input = applyManagedInsertFields(model, values, {
      databaseGeneratedId,
      tenantId: req.vars?.tenantId,
    });
    await assertCreateAllowed(resource, policyCtx, input);
    const outcome = await adapter.requestScope(
      (scope) => adapter.upsertOne!({ conflictTarget: keys, values: input }, scope),
      txCtx(req),
    );
    return {
      status: outcome.created ? 201 : 200,
      body: envelopeOf(resource).success(await shapeOne(resource, policyCtx, req, outcome.row)),
    };
  }

  const outcome = await adapter.transaction<{
    record: Row;
    created: boolean;
    previous: Row | null;
  }>(async (scope) => {
    const ctx = buildHookContext(req, scope);

    // Pre-find determines isCreate for beforeUpsert and drives the synthesis
    // branch / match-and-restore (also used to feed the native path's restore).
    const found = (await adapter.list(buildUpsertFindQuery(resource, req, keys, values), scope))
      .result[0] as Row | undefined;
    const existing = found ?? null;
    const isCreate = existing === null;

    let data = values;
    if (config.hooks?.beforeUpsert) {
      const replaced = await config.hooks.beforeUpsert(ctx, data, isCreate);
      if (replaced !== undefined) data = replaced as Row;
    }

    if (existing !== null) {
      await assertWriteAllowed(resource, policyCtx, existing);
    }

    let record: Row;
    let created: boolean;

    if (
      caps.has('upsert') &&
      adapter.upsertOne !== undefined &&
      (model.tenantField === undefined || caps.has('scopedUpsert')) &&
      model.policies?.create === undefined &&
      model.policies?.read === undefined &&
      model.policies?.write === undefined
    ) {
      // Native path — the adapter owns insert-or-update atomically. Managed
      // insert fields prepare the INSERT case (PK + timestamps); on conflict the
      // adapter keeps the existing PK. Match-and-restore clears the soft-delete
      // field in the values when the matched row is deleted.
      const managed = applyManagedInsertFields(model, data, {
        databaseGeneratedId,
        tenantId: req.vars?.tenantId,
      });
      const conflictValues =
        existing !== null ? (applyUpsertRestore(model, managed, existing) as Row) : managed;
      const res = await adapter.upsertOne({ conflictTarget: keys, values: conflictValues }, scope);
      record = res.row as Row;
      created = res.created;
    } else if (existing !== null) {
      // Synthesis UPDATE branch (+ match-and-restore). `adapter.update` is blind
      // to soft-deleted rows, so a deleted match is un-deleted via `restore`
      // FIRST (making it visible), then patched.
      const existingLookup = lookupFromRow(resource, req, existing);
      if (isSoftDeleted(model, existing)) {
        if (!caps.has('restore') || adapter.restore === undefined) {
          throw new ConfigurationException(
            `Resource '${model.name}': upsert match-and-restore of a soft-deleted row ` +
              `requires an adapter with the 'restore' capability`,
          );
        }
        await adapter.restore(existingLookup, scope);
      }
      // The body PK (present under id:'client') is insert-leg identity only —
      // never rewrite the matched row's PK on the update leg.
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
      // Synthesis CREATE branch.
      const managed = applyManagedInsertFields(model, data, {
        databaseGeneratedId,
        tenantId: req.vars?.tenantId,
      });
      await assertCreateAllowed(resource, policyCtx, managed);
      record = (await adapter.create(managed, scope)) as Row;
      created = true;
    }

    if (config.hooks?.afterUpsert) {
      const replaced = await config.hooks.afterUpsert(ctx, record, created);
      if (replaced !== undefined) record = replaced as Row;
    }

    return { record, created, previous: existing };
  }, txCtx(req));

  await captureAudit(resource, req, 'upsert', {
    recordId: rowIdentifier(resource, outcome.record),
    record: outcome.record,
    ...(outcome.previous !== null ? { previousRecord: outcome.previous } : {}),
    metadata: { created: outcome.created },
  });

  const shaped = await shapeOne(resource, policyCtx, req, outcome.record);
  const base = envelopeOf(resource).success(shaped);
  const body =
    base !== null && typeof base === 'object' && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>), created: outcome.created }
      : base;
  return { status: outcome.created ? 201 : 200, body };
}

export const restoreCloneUpsertExecutors: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  restore: executeRestore,
  clone: executeClone,
  upsert: executeUpsert,
};
