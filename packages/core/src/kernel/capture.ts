/**
 * VERSIONING + AUDIT capture helpers, factored out so the mutation executors
 * stay one-line-ish. Two families, two placements:
 *
 *  - Versioning: `captureVersion` snapshots the PRE-mutation record and (for
 *    update/rollback) stamps the incremented version number onto the write
 *    payload. Called INSIDE the write transaction, before the adapter write —
 *    hono-crud `update.ts` saves the version before the UPDATE and increments
 *    the row's version field (verified: `versioning.test.ts` "save version
 *    before update" pins the snapshot = pre-update state and the row → v2).
 *  - Audit: `captureAudit` / `captureAuditBatch` build who/what/when(+changes)
 *    entries and write them AFTER the mutation succeeds (post-transaction).
 *    hono-crud fires audit through `runAfterResponse` (fire-and-forget); the
 *    native engine AWAITS it so a caller (and a test) observes the entry
 *    without a timer — a deliberate, safe divergence.
 *
 * Stores are DI seams on `ResourceConfig` (`versioningStore` / `auditStore`),
 * validated present at `defineResource` time when the model enables the family;
 * these helpers re-check defensively (engine-level callers bypass definition).
 */

import { ConfigurationException } from '../envelope/errors';
import type { Model } from '../model/model.types';
import { calculateChanges, type AuditAction, type AuditEntry, type AuditStore } from '../audit/index';
import type { VersioningStore } from '../versioning/index';
import type { EngineRequest } from './engine-request';
import type { AnyResource } from './verb-helpers';

type Row = Record<string, unknown>;

/**
 * The version-counter column. hono-crud makes this configurable via the
 * versioning config object; the native `Model.versioning` flag is a boolean
 * (PARITY.md), so the column is fixed to hono-crud's `'version'` default.
 */
export const VERSION_FIELD = 'version';

function primaryKeyValue(model: Model, record: Row): string | number {
  const pk = model.primaryKeys[0] ?? 'id';
  return record[pk] as string | number;
}

function requireVersioningStore(resource: AnyResource): VersioningStore {
  const store = resource.config.versioningStore;
  if (store === undefined) {
    throw new ConfigurationException(
      `Resource '${resource.model.name}': versioning is enabled but no versioningStore is configured`,
    );
  }
  return store;
}

function requireAuditStore(resource: AnyResource): AuditStore {
  const store = resource.config.auditStore;
  if (store === undefined) {
    throw new ConfigurationException(
      `Resource '${resource.model.name}': audit is enabled but no auditStore is configured`,
    );
  }
  return store;
}

/**
 * Snapshot `prior` into the versioning store and, when `writeData` is provided,
 * stamp the incremented version number onto it (the update/rollback write then
 * persists the new version). No-op when the model does not version.
 *
 * The stored entry's `version` is the record's CURRENT version (the state
 * BEFORE this write); the returned/stamped number is that + 1 — mirroring
 * hono-crud `VersionManager.saveVersion` ("store the version BEFORE the update,
 * return the new one"). Called inside the write transaction.
 */
export async function captureVersion(
  resource: AnyResource,
  prior: Row,
  writeData: Row | undefined,
  req: EngineRequest,
): Promise<void> {
  const model = resource.model;
  if (!model.versioning) return;
  const store = requireVersioningStore(resource);

  const currentVersion = (typeof prior[VERSION_FIELD] === 'number' ? (prior[VERSION_FIELD] as number) : 0) || 0;
  const changedBy = req.vars?.userId;
  await store.save(model.tableName, {
    id: crypto.randomUUID(),
    recordId: primaryKeyValue(model, prior),
    version: currentVersion,
    data: { ...prior },
    createdAt: new Date(),
    ...(changedBy !== undefined ? { changedBy } : {}),
  });

  if (writeData !== undefined) writeData[VERSION_FIELD] = currentVersion + 1;
}

/** Build one audit entry (who/what/when + optional field diff). */
function buildAuditEntry(
  model: Model,
  req: EngineRequest,
  action: AuditAction,
  parts: { recordId: string | number; record?: Row; previousRecord?: Row; metadata?: Record<string, unknown> },
): AuditEntry {
  const userId = req.vars?.userId;
  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    action,
    tableName: model.tableName,
    recordId: parts.recordId,
    ...(userId !== undefined ? { userId } : {}),
    ...(parts.record !== undefined ? { record: parts.record } : {}),
    ...(parts.previousRecord !== undefined ? { previousRecord: parts.previousRecord } : {}),
    ...(parts.metadata !== undefined ? { metadata: parts.metadata } : {}),
  };
  if (parts.previousRecord !== undefined && parts.record !== undefined) {
    entry.changes = calculateChanges(parts.previousRecord, parts.record);
  }
  return entry;
}

/**
 * Write one audit entry for a single mutation. No-op when the model does not
 * audit. Call AFTER the mutation commits.
 */
export async function captureAudit(
  resource: AnyResource,
  req: EngineRequest,
  action: AuditAction,
  parts: { recordId: string | number; record?: Row; previousRecord?: Row; metadata?: Record<string, unknown> },
): Promise<void> {
  if (!resource.model.audit) return;
  const store = requireAuditStore(resource);
  await store.log(buildAuditEntry(resource.model, req, action, parts));
}

/**
 * Write a set of audit entries for a batch mutation via `logBatch`. No-op when
 * the model does not audit or the batch is empty. Call AFTER the batch commits.
 */
export async function captureAuditBatch(
  resource: AnyResource,
  req: EngineRequest,
  action: AuditAction,
  items: Array<{ recordId: string | number; record?: Row; previousRecord?: Row }>,
): Promise<void> {
  if (!resource.model.audit || items.length === 0) return;
  const store = requireAuditStore(resource);
  const entries = items.map((item) => buildAuditEntry(resource.model, req, action, item));
  await store.logBatch(entries);
}

/** Resolve the primary-key value of a row for batch audit entry building. */
export function auditRecordId(model: Model, record: Row): string | number {
  return primaryKeyValue(model, record);
}
