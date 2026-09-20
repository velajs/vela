/**
 * Canned time-travel fixtures for the M8b UI panel, typed entirely by
 * `@velajs/studio-protocol` so this module double-guards the wire contract at
 * compile time. It simulates the portable snapshot adapter's behaviour:
 *
 *  - reads (`capabilities`/`currentMark`/`listMarks`/`markForTime`/`preview`)
 *    resolve against a small, deterministic manifest set;
 *  - `preview` reports `schemaCompatible: false` + `incompatibleTables` for the
 *    designated legacy mark, mirroring a post-migration schema drift;
 *  - the destructive ops (`armRestore`/`undo`/`prune`) ride the SAME single-use
 *    428 confirm challenge as every other destructive Studio op (reusing the
 *    {@link makeConfirmStore} ledger), and `armRestore` still 409s with
 *    `TIMETRAVEL_SCHEMA_MISMATCH` on the legacy mark unless `force` is set.
 *
 * This module imports nothing from the other fixture modules except the shared
 * confirm ledger + error helpers, keeping the fixture graph acyclic.
 */
import type {
  RestoreOutcome,
  RestorePreview,
  RestoreRequest,
  RestoreTarget,
  RetentionPolicy,
  TimeTravelCapabilities,
  TimeTravelMark,
  TimeTravelMarkPage,
} from '@velajs/studio-protocol';
import type { FakeTransportTable } from './fake-transport';
import { FakeAdminError, makeErrorBody } from './fake-transport';
import { confirmRequired, makeConfirmStore } from './data-fixtures';

const TT_BASE = 1_700_000_000_000;
const HOUR = 3_600_000;

/** The mark whose snapshot schema no longer matches the current `user` model. */
const LEGACY_MARK_ID = 'snap-legacy';

/** Approx row counts per managed table, aligned with the data-browser dataset. */
const APPROX_ROWS: Record<string, number> = { user: 60, post: 12 };

/**
 * The portable snapshot adapter's capability advertisement — the SAME object the
 * negotiated `studio.capabilities.timeTravel` snapshot carries. Exported so
 * `fixtures.ts` can compose it into `capabilitiesAllOn` (one source of truth).
 */
export const timeTravelCapabilitiesPortable: TimeTravelCapabilities = {
  markByTime: true,
  list: true,
  undo: true,
  inPlace: true,
  restartRequired: false,
  portableExport: true,
  createOnDemand: true,
  granularity: 'snapshot+cdc',
  scopeNote:
    'Restores the managed crud models (row data only) captured in the snapshot. ' +
    'External stores and any tables not managed by Studio are NOT affected.',
};

const mark = (
  id: string,
  createdAt: number,
  label: string,
  schemaHash: string,
): TimeTravelMark => ({
  id,
  kind: 'snapshot',
  time: createdAt,
  label,
  schemaHash,
  tables: ['user', 'post'],
});

/** Deterministic manifest set, newest-first (as `listMarks` returns them). */
export const timeTravelMarks: TimeTravelMark[] = [
  mark('snap-3', TT_BASE + 3 * HOUR, 'nightly-3', 'sha-current'),
  mark('snap-2', TT_BASE + 2 * HOUR, 'nightly-2', 'sha-current'),
  mark('snap-1', TT_BASE + 1 * HOUR, 'nightly-1', 'sha-current'),
  mark(LEGACY_MARK_ID, TT_BASE, 'pre-migration', 'sha-legacy'),
];

/** The most recent mark — what `currentMark` returns. */
export const timeTravelCurrentMark: TimeTravelMark = timeTravelMarks[0];

const toEpoch = (time: number | string): number =>
  typeof time === 'number' ? time : Date.parse(time);

/** The newest mark at or before `t` (or `null`) — mirrors the adapter. */
function latestAtOrBefore(t: number): TimeTravelMark | null {
  return timeTravelMarks.find((m) => (m.time ?? 0) <= t) ?? null;
}

function notFound(message: string): FakeAdminError {
  return new FakeAdminError(
    makeErrorBody('STUDIO_NOT_FOUND', 404, { title: 'Not found', message }),
  );
}

/** Resolve a restore target (bookmark id or point in time) to a mark. */
function resolveMark(target: RestoreTarget): TimeTravelMark {
  if (target.bookmark !== undefined) {
    const found = timeTravelMarks.find((m) => m.id === target.bookmark);
    if (found === undefined) throw notFound(`snapshot '${target.bookmark}' not found`);
    return found;
  }
  if (target.time !== undefined) {
    const t = toEpoch(target.time);
    const found = Number.isNaN(t) ? null : latestAtOrBefore(t);
    if (found === null) throw notFound('no snapshot at or before the requested time');
    return found;
  }
  throw notFound('a restore target (bookmark or time) is required');
}

const incompatibleTablesFor = (m: TimeTravelMark): string[] =>
  m.id === LEGACY_MARK_ID ? ['user'] : [];

// A module-level ledger just for preview tokens (informational; never consumed
// on the UI's dialog path). Destructive ops get their own per-call ledger.
const previewChallenge = makeConfirmStore('tt-preview');

function previewFor(target: RestoreTarget): RestorePreview {
  const resolved = resolveMark(target);
  const incompatible = incompatibleTablesFor(resolved);
  // Preview mints a token via the shared ledger — faithful to the server, where
  // a preview token IS a valid arm token. The UI drives the interactive dialog
  // path (arm with an empty token → fresh 428), so this token simply goes unused.
  const challenge = previewChallenge.issue(`restore data to snapshot ${resolved.id}`);
  return {
    target: resolved,
    affectedTables: (resolved.tables ?? []).map((table) => ({
      table,
      approxRows: APPROX_ROWS[table] ?? 0,
    })),
    schemaCompatible: incompatible.length === 0,
    incompatibleTables: incompatible,
    undoAvailable: true,
    restartRequired: false,
    confirmToken: challenge.confirmToken,
    expiresAt: challenge.expiresAt,
  };
}

// -- destructive-op summaries (mirror the server's @AdminConfirmSummary) ------

function restoreTargetLabel(req: RestoreTarget): string {
  if (req.bookmark !== undefined) return `snapshot ${req.bookmark}`;
  if (req.time !== undefined) return `time ${new Date(toEpoch(req.time)).toISOString()}`;
  return 'the requested point';
}

const armRestoreSummary = (req: RestoreRequest): string =>
  `restore data to ${restoreTargetLabel(req)} (this overwrites current rows; an undo mark is created)`;

const undoSummaryText = (undoMark: string): string =>
  `undo the last restore, returning data to mark ${undoMark}`;

function pruneSummaryText(retention: RetentionPolicy): string {
  const parts: string[] = [];
  if (retention.keepLast !== undefined) parts.push(`keep the newest ${retention.keepLast}`);
  if (retention.maxAgeMs !== undefined) {
    parts.push(`drop snapshots older than ${Math.round(retention.maxAgeMs / 86_400_000)}d`);
  }
  return `prune snapshots (${parts.length > 0 ? parts.join('; ') : 'no-op policy'})`;
}

function schemaMismatch(tables: string[]): FakeAdminError {
  return new FakeAdminError(
    makeErrorBody('TIMETRAVEL_SCHEMA_MISMATCH', 409, {
      title: 'Schema mismatch',
      message: `snapshot schema no longer matches current schema for: ${tables.join(', ')}`,
      hint: 'Recreate the snapshot, or restore with force (dev-host only).',
    }),
  );
}

/**
 * The `timeTravel.*` responders over the canned manifest set. The destructive
 * ops share a fresh single-use confirm ledger per call, so each `fakeTable()`
 * (one per test) gets an isolated token ledger — the generic 428 behaviour.
 */
export function timeTravelResponders(): FakeTransportTable {
  const confirm = makeConfirmStore('tt');
  let undoCounter = 0;
  let snapshotCounter = 0;

  const undoMarkFor = (label: string): TimeTravelMark => {
    undoCounter += 1;
    return mark(`undo-${undoCounter}`, TT_BASE + (20 + undoCounter) * HOUR, label, 'sha-current');
  };

  return {
    'timeTravel.capabilities': timeTravelCapabilitiesPortable,
    'timeTravel.currentMark': timeTravelCurrentMark,
    'timeTravel.listMarks': (args): TimeTravelMarkPage => {
      let marks = timeTravelMarks;
      if (args.before !== undefined) {
        const at = marks.findIndex((m) => m.id === args.before);
        marks = at >= 0 ? marks.slice(at + 1) : [];
      }
      if (args.limit !== undefined && args.limit > 0) marks = marks.slice(0, args.limit);
      return { marks };
    },
    'timeTravel.markForTime': (args): TimeTravelMark | null => {
      const t = toEpoch(args.time);
      return Number.isNaN(t) ? null : latestAtOrBefore(t);
    },
    'timeTravel.preview': (args): RestorePreview => previewFor(args.target),
    'timeTravel.armRestore': (args): RestoreOutcome => {
      if (!confirm.consume(args.confirmToken)) {
        throw confirmRequired(confirm.issue(armRestoreSummary(args)));
      }
      const target = resolveMark(args);
      const incompatible = incompatibleTablesFor(target);
      if (incompatible.length > 0 && args.force !== true) throw schemaMismatch(incompatible);
      return {
        restoredTo: target.id,
        undoMark: undoMarkFor(`undo before restore to ${target.id}`),
        applied: true,
        restartRequested: false,
      };
    },
    'timeTravel.undo': (args): RestoreOutcome => {
      if (!confirm.consume(args.confirmToken)) {
        throw confirmRequired(confirm.issue(undoSummaryText(args.undoMark)));
      }
      return {
        restoredTo: args.undoMark,
        undoMark: undoMarkFor(`undo before restore to ${args.undoMark}`),
        applied: true,
        restartRequested: false,
      };
    },
    'timeTravel.prune': (args): { pruned: number } => {
      if (!confirm.consume(args.confirmToken)) {
        throw confirmRequired(confirm.issue(pruneSummaryText(args.retention)));
      }
      const keepLast = args.retention.keepLast;
      const pruned = keepLast === undefined ? 0 : Math.max(0, timeTravelMarks.length - keepLast);
      return { pruned };
    },
    'timeTravel.createSnapshot': (args): TimeTravelMark => {
      snapshotCounter += 1;
      return mark(
        `snap-new-${snapshotCounter}`,
        TT_BASE + (10 + snapshotCounter) * HOUR,
        args.label ?? `on-demand-${snapshotCounter}`,
        'sha-current',
      );
    },
  };
}
