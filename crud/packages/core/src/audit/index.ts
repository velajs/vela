/**
 * The AUDIT family: a DI-provided `AuditStore` seam (decoupled from the data
 * adapter) plus a plain-`Array` `MemoryAuditStore` for tests and small
 * deployments, the ported audit-entry shape, and the field-diff helper.
 *
 * Parity source: hono-crud 0.13 `src/audit/index.ts` (`AuditLogStorage` +
 * `MemoryAuditLogStorage`) and `src/audit/config.ts` (`calculateChanges`).
 * The native surface FUSES hono-crud's `AuditLogger` (entry building) and
 * `AuditLogStorage` (persistence) into ONE store seam: the engine builds
 * entries in `kernel/capture.ts` and hands them to `store.log` /
 * `store.logBatch`; `store.query` reads them back. EDGE-SAFE (no node:*).
 */

/** The mutation kinds an audit entry records (hono-crud `AuditAction`). */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'upsert'
  | 'batch_create'
  | 'batch_update'
  | 'batch_delete'
  | 'batch_restore'
  | 'batch_upsert';

/** A single field-level difference between two record snapshots. */
export interface FieldChange {
  /** Name of the field that changed. */
  field: string;
  /** Previous value (`undefined` for a field added by the change). */
  oldValue?: unknown;
  /** New value (`undefined` for a field removed by the change). */
  newValue?: unknown;
}

/**
 * One audit-log record. `who` = {@link userId}; `what` = {@link action} plus
 * the {@link record}/{@link previousRecord} snapshots and {@link changes};
 * `when` = {@link timestamp}. Ported from hono-crud `AuditLogEntry`.
 */
export interface AuditEntry<T = Record<string, unknown>> {
  /** Unique id for this entry. */
  id: string;
  /** When the action occurred. */
  timestamp: Date;
  /** The kind of mutation. */
  action: AuditAction;
  /** Physical table/store the record lives in. */
  tableName: string;
  /** Primary-key value of the mutated record. */
  recordId: string | number;
  /** Acting user id, when resolvable from the request. */
  userId?: string;
  /** Post-mutation snapshot (create/update/restore/upsert). */
  record?: T;
  /** Pre-mutation snapshot (update/delete/upsert). */
  previousRecord?: T;
  /** Field-level diff (update/upsert with a previous record). */
  changes?: FieldChange[];
  /** Free-form extra context (e.g. `{ created }` on upsert). */
  metadata?: Record<string, unknown>;
}

/** Read-side filters for {@link AuditStore.query} (hono-crud `getAll` options). */
export interface AuditQuery {
  tableName?: string;
  recordId?: string | number;
  action?: AuditAction;
  userId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * The audit persistence seam. The engine builds {@link AuditEntry} objects and
 * writes them here AFTER a mutation succeeds — one entry per single mutation
 * (`log`), a whole set per batch mutation (`logBatch`). `query` reads them
 * back for consumers and tests. Implement this over your store of choice
 * (Drizzle, KV, D1, ...). All methods are async and edge-safe.
 */
export interface AuditStore {
  /** Persist one entry. */
  log(entry: AuditEntry): Promise<void>;
  /** Persist a set of entries (default: one `log` per entry). */
  logBatch(entries: AuditEntry[]): Promise<void>;
  /** Retrieve entries, newest-first, honoring the optional filters. */
  query(options?: AuditQuery): Promise<AuditEntry[]>;
  /** Release resources (timers, connections). Optional, edge-safe. */
  destroy?(): void;
}

/**
 * In-memory {@link AuditStore} backed by a plain array. Insertion order is
 * preserved; `query` filters and paginates over it. For tests and small
 * single-instance deployments.
 */
export class MemoryAuditStore implements AuditStore {
  private entries: AuditEntry[] = [];

  async log(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async logBatch(entries: AuditEntry[]): Promise<void> {
    for (const entry of entries) this.entries.push(entry);
  }

  async query(options: AuditQuery = {}): Promise<AuditEntry[]> {
    let filtered = this.entries;
    if (options.tableName !== undefined) {
      filtered = filtered.filter((e) => e.tableName === options.tableName);
    }
    if (options.recordId !== undefined) {
      filtered = filtered.filter((e) => e.recordId === options.recordId);
    }
    if (options.action !== undefined) {
      filtered = filtered.filter((e) => e.action === options.action);
    }
    if (options.userId !== undefined) {
      filtered = filtered.filter((e) => e.userId === options.userId);
    }
    if (options.startDate !== undefined) {
      const start = options.startDate;
      filtered = filtered.filter((e) => e.timestamp >= start);
    }
    if (options.endDate !== undefined) {
      const end = options.endDate;
      filtered = filtered.filter((e) => e.timestamp <= end);
    }
    const offset = options.offset ?? 0;
    const limit = options.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  /** Every stored entry (tests). */
  all(): AuditEntry[] {
    return [...this.entries];
  }

  /** Drop every stored entry (tests). */
  clear(): void {
    this.entries = [];
  }
}

/**
 * Compute the field-level diff between two record snapshots. A field is
 * reported when its JSON serialization differs (deep-equal by value), so
 * nested objects/arrays compare structurally. `excludeFields` are skipped.
 * Added fields have `oldValue: undefined`; removed fields `newValue: undefined`.
 *
 * Ported verbatim from hono-crud 0.13 `audit/config.ts`.
 */
export function calculateChanges(
  oldRecord: Record<string, unknown> | undefined,
  newRecord: Record<string, unknown> | undefined,
  excludeFields: string[] = [],
): FieldChange[] {
  const changes: FieldChange[] = [];
  if (!oldRecord && !newRecord) return changes;

  const allKeys = new Set([...Object.keys(oldRecord ?? {}), ...Object.keys(newRecord ?? {})]);
  for (const key of allKeys) {
    if (excludeFields.includes(key)) continue;
    const oldValue = oldRecord?.[key];
    const newValue = newRecord?.[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes.push({ field: key, oldValue, newValue });
    }
  }
  return changes;
}
