/**
 * The VERSIONING family: a DI-provided `VersioningStore` seam (decoupled from
 * the data adapter) plus a plain-`Map` `MemoryVersioningStore` for tests and
 * small deployments, and the ported version-entry shape.
 *
 * Parity source: hono-crud 0.13 `src/versioning/index.ts` (`VersioningStorage`
 * + `MemoryVersioningStorage`). The four core methods are RENAMED to the
 * native seam names — `store→save`, `getByRecordId→list`, `getVersion→get`,
 * `getLatestVersion→latest`. Every operation uses a v2 record key containing
 * a trusted tenant namespace and canonical full primary-key tuple. Legacy
 * table/id-only buckets are intentionally unreachable because they cannot be
 * attributed safely in a multi-tenant deployment. `FieldChange` is shared
 * with the audit family. EDGE-SAFE.
 */

import type { FieldChange } from '../audit/index';

export type { FieldChange } from '../audit/index';

/**
 * One version-history record: a snapshot of `data` at `version`, tagged with
 * its parent `recordId`. Ported from hono-crud `VersionHistoryEntry`.
 */
export interface VersionEntry<T = Record<string, unknown>> {
  /** Unique id of this history entry. */
  id: string;
  /** Primary-key value of the parent record. */
  recordId: string | number;
  /** Version number this snapshot represents. */
  version: number;
  /** The record data captured at this version. */
  data: T;
  /** When the snapshot was taken. */
  createdAt: Date;
  /** Acting user id, when resolvable (versioning's `trackChangedBy`). */
  changedBy?: string;
  /** Optional human summary of the change. */
  changeReason?: string;
  /** Field-level diff from the prior version, when computed. */
  changes?: FieldChange[];
}

/** Tenant-scoped, full-primary-key identity for one versioned record. */
export interface VersionRecordKey {
  /** `global` for a non-tenant model, otherwise the trusted tenant identity. */
  tenantNamespace: string;
  /** Canonical JSON tuple of every `[column, typedValue]` primary-key member. */
  primaryKey: string;
}

const VERSION_KEY_PREFIX = 'vela-version-key:v2:';

/** Stable opaque storage key. The v2 prefix makes legacy unscoped rows fail closed. */
export function serializeVersionRecordKey(key: VersionRecordKey): string {
  if (
    typeof key.tenantNamespace !== 'string' ||
    key.tenantNamespace.length === 0 ||
    key.tenantNamespace.length > 1024 ||
    typeof key.primaryKey !== 'string' ||
    key.primaryKey.length === 0 ||
    key.primaryKey.length > 8192
  ) {
    throw new TypeError('invalid version record key');
  }
  return `${VERSION_KEY_PREFIX}${JSON.stringify([key.tenantNamespace, key.primaryKey])}`;
}

/**
 * The version-history persistence seam. The engine `save`s a pre-mutation
 * snapshot before each versioned write (inside the write transaction) and the
 * version verbs read history back via `list` / `get` / `latest`. Implement
 * over your store of choice; all methods are async and edge-safe.
 */
export interface VersioningStore {
  /** Persist a version snapshot under `tableName`. */
  save(tableName: string, key: VersionRecordKey, entry: VersionEntry): Promise<void>;
  /** All snapshots for a record, NEWEST-FIRST, honoring `limit`/`offset`. */
  list(
    tableName: string,
    key: VersionRecordKey,
    options?: { limit?: number; offset?: number },
  ): Promise<VersionEntry[]>;
  /** One specific snapshot, or `null` when it does not exist. */
  get(tableName: string, key: VersionRecordKey, version: number): Promise<VersionEntry | null>;
  /** Highest stored version number for a record, or `0` when it has none. */
  latest(tableName: string, key: VersionRecordKey): Promise<number>;
  /** Trim to the newest `keepCount` snapshots; returns how many were removed. */
  prune?(tableName: string, key: VersionRecordKey, keepCount: number): Promise<number>;
  /** Drop every snapshot for a record; returns how many were removed. */
  deleteAll?(tableName: string, key: VersionRecordKey): Promise<number>;
  /** Release resources (timers, connections). Optional, edge-safe. */
  destroy?(): void;
}

/**
 * In-memory {@link VersioningStore} backed by a `Map` keyed by table plus the
 * serialized v2 tenant/full-PK key. For tests and small deployments.
 */
export class MemoryVersioningStore implements VersioningStore {
  private versions = new Map<string, VersionEntry[]>();

  private keyFor(tableName: string, key: VersionRecordKey): string {
    return JSON.stringify([tableName, serializeVersionRecordKey(key)]);
  }

  async save(tableName: string, recordKey: VersionRecordKey, entry: VersionEntry): Promise<void> {
    const key = this.keyFor(tableName, recordKey);
    const existing = this.versions.get(key) ?? [];
    existing.push(entry);
    this.versions.set(key, existing);
  }

  async list(
    tableName: string,
    recordKey: VersionRecordKey,
    options?: { limit?: number; offset?: number },
  ): Promise<VersionEntry[]> {
    const entries = this.versions.get(this.keyFor(tableName, recordKey)) ?? [];
    // Newest-first (descending version number).
    const sorted = [...entries].sort((a, b) => b.version - a.version);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? sorted.length;
    return sorted.slice(offset, offset + limit);
  }

  async get(
    tableName: string,
    recordKey: VersionRecordKey,
    version: number,
  ): Promise<VersionEntry | null> {
    const entries = this.versions.get(this.keyFor(tableName, recordKey)) ?? [];
    return entries.find((entry) => entry.version === version) ?? null;
  }

  async latest(tableName: string, recordKey: VersionRecordKey): Promise<number> {
    const entries = this.versions.get(this.keyFor(tableName, recordKey)) ?? [];
    if (entries.length === 0) return 0;
    return Math.max(...entries.map((entry) => entry.version));
  }

  async prune(tableName: string, recordKey: VersionRecordKey, keepCount: number): Promise<number> {
    const key = this.keyFor(tableName, recordKey);
    const entries = this.versions.get(key) ?? [];
    if (entries.length <= keepCount) return 0;
    const sorted = [...entries].sort((a, b) => b.version - a.version);
    const kept = sorted.slice(0, keepCount);
    this.versions.set(key, kept);
    return entries.length - kept.length;
  }

  async deleteAll(tableName: string, recordKey: VersionRecordKey): Promise<number> {
    const key = this.keyFor(tableName, recordKey);
    const count = (this.versions.get(key) ?? []).length;
    this.versions.delete(key);
    return count;
  }

  /** Every stored entry across all records (tests). */
  all(): VersionEntry[] {
    const out: VersionEntry[] = [];
    for (const entries of this.versions.values()) out.push(...entries);
    return out;
  }

  /** Drop every stored entry (tests). */
  clear(): void {
    this.versions.clear();
  }
}
