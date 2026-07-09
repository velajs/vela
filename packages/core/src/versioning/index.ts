/**
 * The VERSIONING family: a DI-provided `VersioningStore` seam (decoupled from
 * the data adapter) plus a plain-`Map` `MemoryVersioningStore` for tests and
 * small deployments, and the ported version-entry shape.
 *
 * Parity source: hono-crud 0.13 `src/versioning/index.ts` (`VersioningStorage`
 * + `MemoryVersioningStorage`). The four core methods are RENAMED to the
 * native seam names — `store→save`, `getByRecordId→list`, `getVersion→get`,
 * `getLatestVersion→latest` — the storage SHAPE (per-`(tableName, recordId)`
 * keying, newest-first ordering, `latest` = max stored version or 0) is
 * preserved. `FieldChange` is shared with the audit family. EDGE-SAFE.
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

/**
 * The version-history persistence seam. The engine `save`s a pre-mutation
 * snapshot before each versioned write (inside the write transaction) and the
 * version verbs read history back via `list` / `get` / `latest`. Implement
 * over your store of choice; all methods are async and edge-safe.
 */
export interface VersioningStore {
  /** Persist a version snapshot under `tableName`. */
  save(tableName: string, entry: VersionEntry): Promise<void>;
  /** All snapshots for a record, NEWEST-FIRST, honoring `limit`/`offset`. */
  list(
    tableName: string,
    recordId: string | number,
    options?: { limit?: number; offset?: number },
  ): Promise<VersionEntry[]>;
  /** One specific snapshot, or `null` when it does not exist. */
  get(
    tableName: string,
    recordId: string | number,
    version: number,
  ): Promise<VersionEntry | null>;
  /** Highest stored version number for a record, or `0` when it has none. */
  latest(tableName: string, recordId: string | number): Promise<number>;
  /** Trim to the newest `keepCount` snapshots; returns how many were removed. */
  prune?(tableName: string, recordId: string | number, keepCount: number): Promise<number>;
  /** Drop every snapshot for a record; returns how many were removed. */
  deleteAll?(tableName: string, recordId: string | number): Promise<number>;
  /** Release resources (timers, connections). Optional, edge-safe. */
  destroy?(): void;
}

/**
 * In-memory {@link VersioningStore} backed by a `Map` keyed by
 * `${tableName}:${recordId}` — so two tables sharing a `recordId` stay fully
 * isolated. For tests and small single-instance deployments.
 */
export class MemoryVersioningStore implements VersioningStore {
  private versions = new Map<string, VersionEntry[]>();

  private keyFor(tableName: string, recordId: string | number): string {
    return `${tableName}:${recordId}`;
  }

  async save(tableName: string, entry: VersionEntry): Promise<void> {
    const key = this.keyFor(tableName, entry.recordId);
    const existing = this.versions.get(key) ?? [];
    existing.push(entry);
    this.versions.set(key, existing);
  }

  async list(
    tableName: string,
    recordId: string | number,
    options?: { limit?: number; offset?: number },
  ): Promise<VersionEntry[]> {
    const entries = this.versions.get(this.keyFor(tableName, recordId)) ?? [];
    // Newest-first (descending version number).
    const sorted = [...entries].sort((a, b) => b.version - a.version);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? sorted.length;
    return sorted.slice(offset, offset + limit);
  }

  async get(
    tableName: string,
    recordId: string | number,
    version: number,
  ): Promise<VersionEntry | null> {
    const entries = this.versions.get(this.keyFor(tableName, recordId)) ?? [];
    return entries.find((entry) => entry.version === version) ?? null;
  }

  async latest(tableName: string, recordId: string | number): Promise<number> {
    const entries = this.versions.get(this.keyFor(tableName, recordId)) ?? [];
    if (entries.length === 0) return 0;
    return Math.max(...entries.map((entry) => entry.version));
  }

  async prune(
    tableName: string,
    recordId: string | number,
    keepCount: number,
  ): Promise<number> {
    const key = this.keyFor(tableName, recordId);
    const entries = this.versions.get(key) ?? [];
    if (entries.length <= keepCount) return 0;
    const sorted = [...entries].sort((a, b) => b.version - a.version);
    const kept = sorted.slice(0, keepCount);
    this.versions.set(key, kept);
    return entries.length - kept.length;
  }

  async deleteAll(tableName: string, recordId: string | number): Promise<number> {
    const key = this.keyFor(tableName, recordId);
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
