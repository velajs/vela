import { rowIdentifier } from '../verb-helpers';
/**
 * Version-verb family: versionHistory / versionRead / versionCompare /
 * versionRollback. Executors register in `versioningExecutors` and surface
 * through `./registry`. All four are gated behind `model.versioning` at
 * decoration time (`resolveEnabledEndpoints`); the executors additionally throw
 * a loud `ConfigurationException` when versioning is off OR the store is
 * missing (defense for direct engine callers).
 *
 * Tenant/owner scope: each verb resolves the PARENT record through the
 * tenant-scoped `buildLookup` first — a record in another tenant (or a missing
 * one) reads as absent → 404, so its version history never leaks (hono-crud
 * `memoryVersionRecordExists` + `versioning-tenant-scope.test.ts`).
 *
 * Parity source: hono-crud 0.13 `endpoints/version-history.ts`
 * (`VersionHistory/Read/Compare/RollbackEndpoint`) + `versioning.test.ts`.
 * Pinned semantics:
 *  - history → `{ versions: [...newest-first], totalVersions: latest }`.
 *  - read    → `:version` path param (coerced, min 1); 404 when absent.
 *  - compare → `?from=&to=` query params (min 1); `{ from, to, changes }`;
 *    a missing version yields `changes: []` (no 404), matching
 *    `VersionManager.compareVersions`.
 *  - rollback→ writes the historical snapshot back via `adapter.update` inside
 *    the tx and returns the resource envelope of the rolled-back row, whose
 *    version field is `currentVersion + 1`.
 *
 * Rollback behavior: hono-crud's rollback does NOT snapshot the
 * pre-rollback state and numbers the new version as `getLatestVersion()+1`.
 * The native rollback SNAPSHOTS the pre-rollback state (like an update) and
 * numbers it `currentVersion+1`. In the pinned rollback test the two coincide
 * (both → 4) because the seeded latest version equals the live record's version.
 */

import {
  ConfigurationException,
  InputValidationException,
  NotFoundException,
} from '../../envelope/errors';
import { calculateChanges } from '../../audit/index';
import { applyManagedUpdateFields } from '../../model/managed-fields';
import {
  serializeVersionRecordKey,
  type VersionEntry,
  type VersioningStore,
  type VersionRecordKey,
} from '../../versioning/index';
import type { CrudEndpointName } from '../../verb-table';
import { captureVersion, versionRecordKeyFor } from '../capture';
import type { EngineRequest, EngineResult } from '../engine-request';
import { envelopeOf } from '../resource';
import {
  assertReadAllowed,
  assertWriteAllowed,
  buildLookup,
  buildPolicyContext,
  shapeOne,
  txCtx,
  type AnyResource,
} from '../verb-helpers';
import type { VerbExecutor } from './registry';

type Row = Record<string, unknown>;

/** Default page size for version history (hono-crud `defaultLimit`). */
const DEFAULT_HISTORY_LIMIT = 20;
/** Maximum page size for version history (hono-crud `maxLimit`). */
const MAX_HISTORY_LIMIT = 100;

/** First value of a possibly-repeated query param. */
function firstParam(query: EngineRequest['query'], key: string): string | undefined {
  const raw = query?.[key];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The versioning store for a versioned resource, or a loud 500. Both cases are
 * unreachable through a stamped route (gated on `model.versioning`, and the
 * store presence is affirmed at `defineResource`) — this guards direct
 * `resource.execute('version*')` callers.
 */
function versioningStoreOf(resource: AnyResource): VersioningStore {
  if (!resource.model.versioning) {
    throw new ConfigurationException(
      `Resource '${resource.model.name}': versioning is not enabled on the model`,
    );
  }
  const store = resource.config.versioningStore;
  if (store === undefined) {
    throw new ConfigurationException(
      `Resource '${resource.model.name}': versioning is enabled but no versioningStore is configured`,
    );
  }
  return store;
}

/**
 * Resolve the tenant-scoped parent record; a missing/foreign one is a 404 so
 * version data stays owner-private. Returns the live row (never soft-delete
 * filtered — a soft-deleted parent still owns its history).
 */
async function requireOwnedRecord(resource: AnyResource, req: EngineRequest): Promise<Row> {
  const lookup = buildLookup(resource, req);
  const found = await resource.config.adapter.requestScope(
    (scope) => resource.config.adapter.readOne(lookup, { withDeleted: true }, scope),
    txCtx(req),
  );
  if (!found) throw new NotFoundException(resource.model.name, lookup.value);
  await assertReadAllowed(resource, buildPolicyContext(req), found, lookup.value);
  return found;
}

/** Never expose a store-owned raw snapshot or its unshaped field diff. */
async function shapeVersionEntry(
  resource: AnyResource,
  req: EngineRequest,
  expectedKey: VersionRecordKey,
  entry: VersionEntry,
): Promise<Omit<VersionEntry, 'data' | 'changes'> & { data: Row }> {
  const { data, changes: _changes, ...metadata } = entry;
  const snapshot = data as Row;
  assertVersionEntryScope(resource, req, expectedKey, entry);
  const policyCtx = buildPolicyContext(req);
  await assertReadAllowed(resource, policyCtx, snapshot, String(entry.recordId));
  return {
    ...metadata,
    data: await shapeOne(resource, policyCtx, req, snapshot),
  };
}

/** Defense in depth against a buggy or hostile store returning another scope. */
function assertVersionEntryScope(
  resource: AnyResource,
  req: EngineRequest,
  expectedKey: VersionRecordKey,
  entry: VersionEntry,
): void {
  let actualKey: VersionRecordKey;
  try {
    actualKey = versionRecordKeyFor(resource.model, entry.data as Row, req);
  } catch {
    throw new NotFoundException('version', String(entry.version));
  }
  if (serializeVersionRecordKey(actualKey) !== serializeVersionRecordKey(expectedKey)) {
    throw new NotFoundException('version', String(entry.version));
  }
}

/** Parse + validate a `:version` path param (positive integer). */
function parseVersionParam(req: EngineRequest): number {
  const raw = req.params?.version;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new InputValidationException(
      `Invalid version '${raw ?? ''}': expected a positive integer`,
    );
  }
  return version;
}

// ---------------------------------------------------------------------------
// versionHistory — GET /:id/versions
// ---------------------------------------------------------------------------

/**
 * List a record's version history newest-first. `?limit` (1..100, default 20)
 * and `?offset` (>= 0) paginate. Response:
 * `{ success, result: { versions, totalVersions } }` where `totalVersions` is
 * the highest stored version number (hono-crud `getLatestVersion`).
 */
async function executeVersionHistory(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const store = versioningStoreOf(resource);
  const record = await requireOwnedRecord(resource, req);
  const recordKey = versionRecordKeyFor(resource.model, record, req);

  const limitRaw = firstParam(req.query, 'limit');
  const offsetRaw = firstParam(req.query, 'offset');
  const limit =
    limitRaw !== undefined
      ? Math.min(
          MAX_HISTORY_LIMIT,
          Math.max(1, Number.parseInt(limitRaw, 10) || DEFAULT_HISTORY_LIMIT),
        )
      : DEFAULT_HISTORY_LIMIT;
  const offset = offsetRaw !== undefined ? Math.max(0, Number.parseInt(offsetRaw, 10) || 0) : 0;

  const stored = await store.list(resource.model.tableName, recordKey, { limit, offset });
  const versions = await Promise.all(
    stored.map((entry) => shapeVersionEntry(resource, req, recordKey, entry)),
  );
  const totalVersions = await store.latest(resource.model.tableName, recordKey);

  return {
    status: 200,
    body: envelopeOf(resource).success({ versions, totalVersions }),
  };
}

// ---------------------------------------------------------------------------
// versionRead — GET /:id/versions/:version
// ---------------------------------------------------------------------------

/**
 * Read one specific version snapshot. `:version` is a positive integer; a
 * missing snapshot is a 404. Response: `{ success, result: <VersionEntry> }`.
 */
async function executeVersionRead(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const store = versioningStoreOf(resource);
  const version = parseVersionParam(req);
  const record = await requireOwnedRecord(resource, req);
  const recordId = rowIdentifier(resource, record);
  const recordKey = versionRecordKeyFor(resource.model, record, req);

  const entry = await store.get(resource.model.tableName, recordKey, version);
  if (!entry) throw new NotFoundException(`version ${version}`, String(recordId));

  return {
    status: 200,
    body: envelopeOf(resource).success(await shapeVersionEntry(resource, req, recordKey, entry)),
  };
}

// ---------------------------------------------------------------------------
// versionCompare — GET /:id/versions/compare?from=&to=
// ---------------------------------------------------------------------------

/** Parse + validate a `from`/`to` compare query param (positive integer). */
function parseCompareParam(req: EngineRequest, key: 'from' | 'to'): number {
  const raw = firstParam(req.query, key);
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1) {
    throw new InputValidationException(`Invalid '${key}' version: expected a positive integer`);
  }
  return value;
}

/**
 * Diff two versions of a record. `?from` and `?to` are positive integers.
 * Response: `{ success, result: { from, to, changes } }`. When either version
 * is missing, `changes` is `[]` (no 404) — parity with
 * `VersionManager.compareVersions`.
 */
async function executeVersionCompare(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const store = versioningStoreOf(resource);
  const from = parseCompareParam(req, 'from');
  const to = parseCompareParam(req, 'to');
  const record = await requireOwnedRecord(resource, req);
  const recordId = rowIdentifier(resource, record);
  const recordKey = versionRecordKeyFor(resource.model, record, req);

  const [entryFrom, entryTo] = await Promise.all([
    store.get(resource.model.tableName, recordKey, from),
    store.get(resource.model.tableName, recordKey, to),
  ]);
  if (entryFrom) assertVersionEntryScope(resource, req, recordKey, entryFrom);
  if (entryTo) assertVersionEntryScope(resource, req, recordKey, entryTo);
  const policyCtx = buildPolicyContext(req);
  if (entryFrom)
    await assertReadAllowed(resource, policyCtx, entryFrom.data as Row, String(recordId));
  if (entryTo) await assertReadAllowed(resource, policyCtx, entryTo.data as Row, String(recordId));
  const changes =
    entryFrom && entryTo
      ? calculateChanges(
          await shapeOne(resource, policyCtx, req, entryFrom.data as Row),
          await shapeOne(resource, policyCtx, req, entryTo.data as Row),
        )
      : [];

  return { status: 200, body: envelopeOf(resource).success({ from, to, changes }) };
}

// ---------------------------------------------------------------------------
// versionRollback — POST /:id/versions/:version/rollback
// ---------------------------------------------------------------------------

/**
 * Restore a record to a historical version. Reads the target snapshot (404 if
 * absent), snapshots the PRE-rollback state (`captureVersion`, which also
 * stamps the incremented version onto the write payload), then writes the
 * historical data back via `adapter.update` inside the transaction. Response:
 * the resource envelope of the rolled-back row (its `version` = currentVersion
 * + 1). Tenant/owner-scoped: a foreign/missing record is a 404.
 */
async function executeVersionRollback(
  resource: AnyResource,
  req: EngineRequest,
): Promise<EngineResult> {
  const store = versioningStoreOf(resource);
  const version = parseVersionParam(req);
  const config = resource.config;
  const model = resource.model;
  const policyCtx = buildPolicyContext(req);
  const lookup = buildLookup(resource, req);

  const rolledBack = await config.adapter.transaction(async (scope) => {
    // Owner-scope BEFORE mutating (soft-delete-inclusive: a deleted parent can
    // still be rolled back — its record row is what we own-check).
    const current = (await config.adapter.readOne(
      lookup,
      { withDeleted: true },
      scope,
    )) as Row | null;
    if (!current) throw new NotFoundException(model.name, lookup.value);
    await assertReadAllowed(resource, policyCtx, current, lookup.value);
    await assertWriteAllowed(resource, policyCtx, current);

    const recordId = rowIdentifier(resource, current);
    const recordKey = versionRecordKeyFor(model, current, req);
    const entry = await store.get(model.tableName, recordKey, version);
    if (!entry) throw new NotFoundException(`version ${version}`, String(recordId));
    assertVersionEntryScope(resource, req, recordKey, entry);
    await assertReadAllowed(resource, policyCtx, entry.data as Row, String(recordId));

    // Snapshot the pre-rollback state and stamp the incremented version onto
    // the historical data we are about to write back.
    const writeData = applyManagedUpdateFields(model, entry.data as Row) as Row;
    await captureVersion(resource, current, writeData, req);

    const updated = (await config.adapter.update(lookup, writeData, scope)) as Row | null;
    if (!updated) throw new NotFoundException(model.name, lookup.value);
    return updated;
  }, txCtx(req));

  const shaped = await shapeOne(resource, policyCtx, req, rolledBack);
  return { status: 200, body: envelopeOf(resource).success(shaped) };
}

export const versioningExecutors: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  versionHistory: executeVersionHistory,
  versionRead: executeVersionRead,
  versionCompare: executeVersionCompare,
  versionRollback: executeVersionRollback,
};
