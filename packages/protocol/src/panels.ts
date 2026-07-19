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

/** A scheduled job row. */
export interface ScheduleJobRow {
  name: string;
  cron?: string;
  lastRun?: number;
  nextRun?: number;
  enabled?: boolean;
}

/** A declared cron trigger. */
export interface CronTriggerRow {
  name: string;
  cron: string;
  timezone?: string;
  nextRun?: number;
}

// ---- flags ----------------------------------------------------------------

/** A feature-flag row. */
export interface FlagRow {
  key: string;
  enabled: boolean;
  description?: string;
}

/** The result of evaluating a flag against a context. */
export interface FlagEvaluation {
  key: string;
  value: unknown;
  reason?: string;
}

// ---- logs -----------------------------------------------------------------

/** A captured application log line. */
export interface AdminLogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  source?: string;
  fields?: Record<string, unknown>;
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
