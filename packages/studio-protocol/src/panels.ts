/**
 * Read-panel row types for the package-backed op sets (auth / queue / schedule /
 * flags / logs / live / presence / audit / transfer / overview).
 *
 * Kept MINIMAL and honest: only the fields the panels actually need. Field names
 * are chosen to match the real backing services later ops call (`@velajs/auth`,
 * `@velajs/feature-flags`, `vela/src/queue`, `vela/src/schedule*`) so they are
 * not fantasy; the server package narrows them to concrete service reads.
 */

// ---- auth -----------------------------------------------------------------

/** A user row for the auth users panel. */
export interface AuthUserRow {
  id: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  image?: string;
  role?: string;
  banned?: boolean;
  createdAt: number;
}

/** A session row for the auth sessions panel. */
export interface AuthSessionRow {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  ipAddress?: string;
  userAgent?: string;
}

/** An organization row (better-auth organization plugin). */
export interface AuthOrgRow {
  id: string;
  name: string;
  slug?: string;
  memberCount?: number;
  createdAt: number;
}

/** The detail view for a single user. */
export interface AuthUserDetail {
  user: AuthUserRow;
  sessions: AuthSessionRow[];
  organizations: AuthOrgRow[];
}

// ---- queue ----------------------------------------------------------------

/** A queue row for the queues panel. */
export interface QueueRow {
  name: string;
  kind: string;
  depth?: number;
}

/** A live queue-depth reading. */
export interface QueueDepthRow {
  name: string;
  depth: number;
  inFlight?: number;
}

/** A dead-letter-queue entry. */
export interface DlqEntryRow {
  id: string;
  queue: string;
  failedAt: number;
  attempts: number;
  error?: string;
  payload?: unknown;
}

// ---- schedule -------------------------------------------------------------

/**
 * A scheduled job row. Mirrors vela's `ScheduleJobRef` (`kind` + `expression?` /
 * `ms?`). `ScheduleJobRef` carries no name or run timestamps, so `name`,
 * `lastRun`, and `nextRun` are all server-synthesized around the driver read.
 */
export interface ScheduleJobRow {
  /** Server-synthesized display name (derived from the job's `methodName`). */
  name: string;
  kind: 'cron' | 'interval';
  /** Cron expression (`kind: 'cron'`). */
  expression?: string;
  /** Interval period in ms (`kind: 'interval'`). */
  ms?: number;
  /** Server-synthesized: last fire time (epoch ms). */
  lastRun?: number;
  /** Server-synthesized: next scheduled fire time (epoch ms). */
  nextRun?: number;
}

/** A declared cron trigger. */
export interface CronTriggerRow {
  name: string;
  cron: string;
  nextRun?: number;
}

// ---- flags ----------------------------------------------------------------

/**
 * A value a feature flag can resolve to. A local structural mirror of
 * `@velajs/feature-flags`' `FlagValue` (`boolean | string | number | object`) —
 * mirrored, never imported, so the wire contract is independent of that package.
 */
export type FlagValue = boolean | string | number | object;

/**
 * Why a flag evaluation returned the value it did. A local structural mirror of
 * `@velajs/feature-flags`' `FlagEvaluationReason` union (its members, exactly).
 */
export type FlagEvaluationReason = 'STATIC' | 'DEFAULT' | 'ERROR';

/**
 * A feature-flag row. A flag resolves to a {@link FlagValue}, not a boolean —
 * the driver has no `enabled`/`description` fields to back those, so the row
 * carries only the key and its resolved value.
 */
export interface FlagRow {
  key: string;
  value: FlagValue;
}

/**
 * The result of evaluating a flag against a context. Mirrors
 * `@velajs/feature-flags`' `FlagEvaluationDetails`: `flagKey`, the resolved
 * {@link FlagValue}, a required {@link FlagEvaluationReason}, and an optional
 * `errorMessage` present only on `reason: 'ERROR'`.
 */
export interface FlagEvaluation {
  flagKey: string;
  value: FlagValue;
  reason: FlagEvaluationReason;
  errorMessage?: string;
}

// ---- logs -----------------------------------------------------------------

/** A captured application log line. */
export interface AdminLogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  source?: string;
  fields?: Record<string, unknown>;
  /** Optional handler timing. Does not measure stream/background completion. */
  invocation?: StudioInvocationDiagnostic;
}

/** An observation of the public interceptor boundary, never an authority token. */
export interface StudioInvocationDiagnostic {
  kind: string;
  source: string;
  moduleId?: string;
  invocationId?: string;
  elapsedMs: number;
  outcome: 'returned' | 'threw';
  boundary: 'handler';
}

// ---- live / presence ------------------------------------------------------

/** An active live subscription. */
export interface LiveSubscriptionRow {
  id: string;
  room: string;
  tags: string[];
  connectedAt: number;
  clientId?: string;
}

/** A presence room occupancy row. */
export interface PresenceRoomRow {
  room: string;
  count: number;
  members?: string[];
}

// ---- audit ----------------------------------------------------------------

/** One recorded admin audit row (mirrors the server's `AdminAuditEntry`). */
export interface AdminAuditEntry {
  ts: number;
  op: string;
  mode: 'read' | 'write';
  subject: string;
  status: number;
  ms: number;
  ip: string | null;
  detail?: { target?: string; summary?: string; extra?: Record<string, unknown> };
}

// ---- transfer -------------------------------------------------------------

/** The result of a transfer export (a downloadable NDJSON URL). */
export interface TransferExportResult {
  exportUrl: string;
}

/**
 * A transfer import request. Destructive (bulk ingest): `confirmToken` required,
 * so it satisfies the destructive-op contract.
 */
export interface TransferImportRequest {
  model: string;
  ndjson: string;
  confirmToken: string;
}

/** The result of a transfer import. */
export interface TransferImportResult {
  imported: number;
  errors: Array<{ line: number; message: string }>;
}

// ---- overview -------------------------------------------------------------

/** A minimal health + counts summary for the overview panel. */
export interface OverviewSummary {
  status: 'ok' | 'degraded';
  uptimeMs?: number;
  counts: {
    models?: number;
    routes?: number;
    modules?: number;
    queues?: number;
    scheduledJobs?: number;
    flags?: number;
  };
}
