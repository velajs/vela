/**
 * Time-travel wire contract — adopted verbatim (in concept) from the
 * `timetravel.contracts` design slice. Pure types only: the `TimeTravelPort`
 * interface lives here, but its DI token is declared in the server package.
 *
 * Marks are opaque (a CF DO bookmark string, or a portable manifest id). The
 * lifecycle is preview -> confirmToken -> arm -> undo; unavailable environments
 * surface `TIMETRAVEL_UNAVAILABLE` (409).
 */

/** How precisely a port can address a point in time. */
export type TimeTravelGranularity = 'bookmark' | 'snapshot' | 'snapshot+cdc';

/**
 * Capability negotiation shape the UI reads for defaults-shown / hide-on-disabled
 * affordances. Both adapters expose their full power here rather than collapsing
 * to a lowest common denominator.
 */
export interface TimeTravelCapabilities {
  /** `getMarkForTime` supported. */
  markByTime: boolean;
  /** `listMarks` supported (portable: yes; CF DO: no). */
  list: boolean;
  /** `armRestore` returns an undo mark. */
  undo: boolean;
  /** Restore applies to the live store. */
  inPlace: boolean;
  /** CF DO: applies only on restart/abort. */
  restartRequired: boolean;
  /** A snapshot can be downloaded off-platform. */
  portableExport: boolean;
  /** `createSnapshot` supported. */
  createOnDemand: boolean;
  /** Addressing granularity of this port. */
  granularity: TimeTravelGranularity;
  /** Human, honest note on what a restore actually covers. */
  scopeNote: string;
}

/** Selects the dataset / log-scope to operate on. */
export interface TimeTravelScope {
  /** Portable: a named table-group (`'default'` = all managed). CF: the DO room/name. */
  dataset?: string;
}

/** An opaque, addressable point in time. */
export interface TimeTravelMark {
  /** Opaque id: a CF bookmark string or a portable manifest id. */
  id: string;
  kind: 'bookmark' | 'snapshot';
  /** Epoch-ms when known. */
  time?: number;
  label?: string;
  /** Portable snapshots only. */
  schemaHash?: string;
  sizeBytes?: number;
  /** Portable: the tables captured by this mark. */
  tables?: string[];
}

/** A page of marks (cursor pagination; next-only). */
export interface TimeTravelMarkPage {
  marks: TimeTravelMark[];
  nextCursor?: string;
}

/** Addresses a restore target — an explicit mark id or a point in time. */
export interface RestoreTarget {
  /** Explicit mark id (e.g. an undo mark) — wins over `time`. */
  bookmark?: string;
  /** Epoch-ms or ISO string. */
  time?: number | string;
}

/** The result of a restore preview; `confirmToken` must be echoed to `armRestore`. */
export interface RestorePreview {
  target: TimeTravelMark;
  affectedTables: Array<{ table: string; approxRows?: number }>;
  /** `manifest.schemaHash === current`. */
  schemaCompatible: boolean;
  incompatibleTables: string[];
  undoAvailable: boolean;
  restartRequired: boolean;
  /** Single-use token bound to (mark, tables, schemaHash); echo to `armRestore`. */
  confirmToken: string;
  /** Epoch-ms after which the `confirmToken` is rejected. */
  expiresAt: number;
}

/** A confirmed restore request. */
export interface RestoreRequest extends RestoreTarget {
  scope?: TimeTravelScope;
  /** CF: also `ctx.abort()` to apply now. */
  restart?: boolean;
  /** Override a schema mismatch (dev-host only). */
  force?: boolean;
  /** The token echoed from {@link RestorePreview}. */
  confirmToken: string;
}

/** The outcome of an armed restore. */
export interface RestoreOutcome {
  /** Target mark id. */
  restoredTo: string;
  /** Restore to this mark to undo. */
  undoMark?: TimeTravelMark;
  /** `false` when armed-for-next-restart (CF, `restart: false`). */
  applied: boolean;
  restartRequested: boolean;
}

/** Snapshot retention policy for pruning. */
export interface RetentionPolicy {
  keepLast?: number;
  maxAgeMs?: number;
}

/** A portable snapshot manifest (adapter B). */
export interface SnapshotManifest {
  id: string;
  createdAt: number;
  label?: string;
  tables: Array<{ table: string; rows: number; schemaHash: string; ndjsonKey: string }>;
  /** Set when a change source captured a window. */
  changeLog?: { fromTs: number; toTs: number };
}

/** A single CDC record kind. */
export type StudioChangeKind = 'insert' | 'update' | 'delete';

/** A single committed change (CDC replay input). */
export interface StudioChange {
  ts: number;
  table: string;
  kind: StudioChangeKind;
  key: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/**
 * The time-travel seam. Two adapters implement it: the portable NDJSON
 * snapshot/replay adapter and the CF-native DO PITR bookmark adapter. Declared
 * here as pure types; the `TIME_TRAVEL_PORT` DI token lives in the server package.
 */
export interface TimeTravelPort {
  /** `'cf-do-pitr'` | `'portable-snapshot'`. */
  readonly id: string;
  capabilities(scope?: TimeTravelScope): TimeTravelCapabilities;
  getCurrentMark(scope?: TimeTravelScope): Promise<TimeTravelMark>;
  getMarkForTime?(time: number | string, scope?: TimeTravelScope): Promise<TimeTravelMark | null>;
  listMarks?(
    scope?: TimeTravelScope,
    opts?: { limit?: number; before?: string },
  ): Promise<TimeTravelMarkPage>;
  preview(target: RestoreTarget, scope?: TimeTravelScope): Promise<RestorePreview>;
  armRestore(req: RestoreRequest): Promise<RestoreOutcome>;
  createSnapshot?(opts?: { scope?: TimeTravelScope; label?: string }): Promise<TimeTravelMark>;
  exportSnapshot?(markId: string): Promise<ReadableStream<Uint8Array>>;
  prune?(retention: RetentionPolicy, scope?: TimeTravelScope): Promise<{ pruned: number }>;
}
