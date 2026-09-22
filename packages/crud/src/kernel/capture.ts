import { CrudTransactionScope } from './transaction';
/** Transaction-bound version capture and configurable audit persistence.
 * Resource execution binds history stores before mutation callbacks run.
 * Transactional audits share the row transaction; post-commit audits remain
 * best effort and are delivered only after the outer transaction commits.
 */

import { ConfigurationException, ConflictException } from '../envelope/errors';
import type { Model } from '../model/model.types';
import {
  calculateChanges,
  type AuditAction,
  type AuditEntry,
  type AuditStore,
} from '../audit/index';
import {
  historyTenantNamespace,
  validateVersionNumber,
  VersionConflictError,
  type VersioningStore,
  type VersionRecordKey,
} from '../versioning/index';
import type { EngineRequest } from './engine-request';
import { rowIdentifier, type AnyResource } from './verb-helpers';

type Row = Record<string, unknown>;

/**
 * The version-counter column is fixed to `version`; `Model.versioning`
 * enables capture without changing the column name.
 */
export const VERSION_FIELD = 'version';

/**
 * Build the v2 version-store identity from trusted request tenancy and every
 * model primary-key field. Exported so read/compare/rollback use exactly the
 * same namespace as mutation capture.
 */
export function versionRecordKeyFor(
  model: Model,
  record: Row,
  req: EngineRequest,
): VersionRecordKey {
  let tenantNamespace = 'global';
  if (model.tenantField !== undefined) {
    const tenantId = req.vars?.tenantId;
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new ConfigurationException(
        `Model '${model.name}': versioning requires a trusted tenant context`,
      );
    }
    if (record[model.tenantField] !== tenantId) {
      throw new ConfigurationException(
        `Model '${model.name}': versioned row does not match the trusted tenant`,
      );
    }
    tenantNamespace = `tenant:${JSON.stringify(tenantId)}`;
  }

  const tuple = model.primaryKeys.map((column) => {
    const value = record[column];
    if (typeof value === 'string') return [column, 'string', value] as const;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return [column, 'number', value] as const;
    }
    throw new ConfigurationException(
      `Model '${model.name}': versioned row has an invalid primary key '${column}'`,
    );
  });
  return { tenantNamespace, primaryKey: JSON.stringify(tuple) };
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
 * BEFORE this write); the stamped number is that + 1. The bound store saves
 * inside the same transaction as the row mutation.
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

  const currentVersion = prior[VERSION_FIELD] ?? 0;
  if (typeof currentVersion !== 'number') throw new TypeError('Invalid row version');
  validateVersionNumber(currentVersion);
  if (currentVersion >= Number.MAX_SAFE_INTEGER) throw new TypeError('Version counter exhausted');
  const changedBy = req.vars?.userId;
  try {
    await store.save(model.tableName, versionRecordKeyFor(model, prior, req), {
      id: crypto.randomUUID(),
      recordId: rowIdentifier(resource, prior),
      version: currentVersion,
      data: { ...prior },
      createdAt: new Date(),
      ...(changedBy !== undefined ? { changedBy } : {}),
    });
  } catch (error) {
    if (error instanceof VersionConflictError)
      throw new ConflictException('Record version changed concurrently');
    throw error;
  }

  if (writeData !== undefined) writeData[VERSION_FIELD] = currentVersion + 1;
}

/** Build one audit entry (who/what/when + optional field diff). */
function buildAuditEntry(
  model: Model,
  req: EngineRequest,
  action: AuditAction,
  parts: {
    recordId: string | number;
    record?: Row;
    previousRecord?: Row;
    metadata?: Record<string, unknown>;
  },
): AuditEntry {
  const userId = req.vars?.userId;
  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    tenantNamespace: historyTenantNamespace(model.tenantField ? req.vars?.tenantId : undefined),
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
 * audit. Transaction mode persists before commit; postCommit mode defers delivery.
 */
export async function captureAudit(
  resource: AnyResource,
  req: EngineRequest,
  action: AuditAction,
  parts: {
    recordId: string | number;
    record?: Row;
    previousRecord?: Row;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!resource.model.audit) return;
  const store = requireAuditStore(resource);
  const entry = buildAuditEntry(resource.model, req, action, parts);
  if (resource.config.auditPersistence?.mode === 'transaction') {
    if (!req.transaction)
      throw new ConfigurationException('Transactional audit requires a CRUD transaction');
    await store.log(entry);
  } else {
    const deliver = async () => {
      try {
        await store.log(entry);
      } catch (error) {
        console.error('[crud] post-commit audit failed', error);
      }
    };
    if (req.transaction) CrudTransactionScope.defer(req.transaction, deliver);
    else await deliver();
  }
}

/**
 * Write a set of audit entries for a batch mutation via `logBatch`. No-op when
 * the model does not audit or the batch is empty. Transaction mode persists
 * before commit; postCommit mode defers delivery.
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
  if (resource.config.auditPersistence?.mode === 'transaction') {
    if (!req.transaction)
      throw new ConfigurationException('Transactional audit requires a CRUD transaction');
    await store.logBatch(entries);
  } else {
    const deliver = async () => {
      try {
        await store.logBatch(entries);
      } catch (error) {
        console.error('[crud] post-commit audit failed', error);
      }
    };
    if (req.transaction) CrudTransactionScope.defer(req.transaction, deliver);
    else await deliver();
  }
}

/** Resolve the primary-key value of a row for batch audit entry building. */
export function auditRecordId(model: Model, record: Row): string | number {
  const key = model.primaryKeys[0] ?? 'id';
  const value = record[key];
  return model.primaryKeys.length > 1
    ? JSON.stringify(Object.fromEntries(model.primaryKeys.map((k) => [k, record[k]])))
    : typeof value === 'number'
      ? value
      : String(value ?? '');
}
