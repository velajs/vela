/**
 * Durable Object point-in-time recovery (PITR) — thin, testable wrappers over a
 * SQLite-backed DO's native bookmark API. A SQLite Durable Object exposes three
 * storage methods (last-30-days PITR):
 *
 *   - `getCurrentBookmark()` — an opaque bookmark for the storage's current state.
 *   - `getBookmarkForTime(t)` — the bookmark closest to a wall-clock instant.
 *   - `onNextSessionRestoreBookmark(b)` — arm a restore to bookmark `b`; the DO
 *     restores to it the next time it starts a session, and the call RETURNS a
 *     bookmark for the state JUST BEFORE the restore (the undo handle).
 *
 * These methods are ABSENT on a non-SQLite DO (key-value storage) and in some
 * local-dev runtimes, so this module models storage structurally with all three
 * methods OPTIONAL and degrades to a typed {@link DoPitrUnavailableError} (a
 * `code: 'PITR_UNAVAILABLE'`, HTTP 409 error) rather than an
 * `undefined is not a function` TypeError when a needed method is missing.
 *
 * Neither wrapper aborts the DO — `armDoPitr` only ARMS the restore and returns
 * the undo bookmark; the caller (the WS-DO RPC method) decides whether to
 * `ctx.abort()` to apply it immediately vs. on the next natural restart.
 *
 * This file is `cloudflare:workers`-free and pulls in NOTHING from `@velajs/vela`
 * or `@velajs/studio` — it is the raw capability the studio `TimeTravelPort`
 * wraps. Dependency direction is one-way: studio → cloudflare, never the reverse.
 */

/**
 * The subset of `DurableObjectStorage` this module touches, with every method
 * OPTIONAL so it structurally models a non-SQLite DO whose storage has none of
 * them. A real `DurableObjectStorage` (whose methods are required) is assignable
 * to this shape.
 */
export interface DoPitrStorage {
  getCurrentBookmark?(): Promise<string>;
  getBookmarkForTime?(timestamp: number | Date): Promise<string>;
  onNextSessionRestoreBookmark?(bookmark: string): Promise<string>;
}

/** A read of a DO's current bookmark (+ the by-time bookmark when a time is given). */
export interface DoPitrBookmarkRead {
  /** The bookmark for the DO storage's current state. */
  current: string;
  /** The bookmark closest to the requested time (only when `time` was passed). */
  forTime?: string;
}

/** Arming input for {@link armDoPitr}: a target (bookmark WINS over time) + restart intent. */
export interface DoPitrArmOptions {
  /** An explicit target bookmark. Takes precedence over `time`. */
  bookmark?: string;
  /** A wall-clock target (epoch ms, ISO string, or Date), resolved to a bookmark. */
  time?: number | string | Date;
  /** Caller intent to restart-now; recorded on the result. `armDoPitr` never aborts. */
  restart?: boolean;
}

/** The result of arming a PITR restore (before any restart is applied). */
export interface DoPitrArmResult {
  /** The bookmark the restore is armed to. */
  restoredTo: string;
  /** The bookmark for the pre-restore state — restore to this to undo. */
  undoBookmark: string;
  /** Whether a restart-now was requested (the RPC layer performs the actual abort). */
  restarted: boolean;
}

/** The RPC surface a PITR-capable Vela WebSocket DO stub exposes to a Worker. */
export interface VelaDoPitrRpc {
  pitrCurrentBookmark(): Promise<DoPitrBookmarkRead>;
  pitrBookmarkForTime(time: number | string): Promise<DoPitrBookmarkRead>;
  pitrArmRestore(opts: DoPitrArmOptions): Promise<DoPitrArmResult>;
}

/** Structural view of a DO id (avoids depending on `@cloudflare/workers-types` downstream). */
export interface DoPitrId {
  toString(): string;
  readonly name?: string | null;
}

/**
 * Structural view of a DO namespace binding whose stubs speak the PITR RPC. A
 * downstream (the studio `@velajs/studio/cloudflare` port) types the app's
 * namespace binding as this shape to reach the PITR methods without importing
 * `@cloudflare/workers-types`.
 */
export interface DoPitrNamespace {
  idFromName(name: string): DoPitrId;
  get(id: DoPitrId): VelaDoPitrRpc;
}

const PITR_UNAVAILABLE_CODE = 'PITR_UNAVAILABLE';

/**
 * Thrown when a DO's storage lacks the SQLite bookmark API (non-SQLite DO, or a
 * local runtime without PITR). Carries a stable `code` + HTTP 409 `status`, and
 * a recognizable `name`/message so the studio port can map it to
 * `TIMETRAVEL_UNAVAILABLE` even after the error crosses the Worker→DO RPC hop
 * (which preserves `name` + `message`, not arbitrary own-properties).
 */
export class DoPitrUnavailableError extends Error {
  readonly code = PITR_UNAVAILABLE_CODE;
  readonly status = 409;

  constructor(message = 'Durable Object point-in-time recovery is unavailable on this storage') {
    super(`${PITR_UNAVAILABLE_CODE}: ${message}`);
    this.name = 'DoPitrUnavailableError';
  }
}

/**
 * True when `error` signals DO PITR unavailability. Robust across the Worker→DO
 * RPC hop: checks the `code` own-property (same process) AND the `name` / message
 * sentinel (survive RPC serialization) so a downstream can classify it either way.
 */
export function isDoPitrUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; name?: unknown; message?: unknown };
  if (record.code === PITR_UNAVAILABLE_CODE) return true;
  if (record.name === 'DoPitrUnavailableError') return true;
  return (
    typeof record.message === 'string' && record.message.startsWith(`${PITR_UNAVAILABLE_CODE}:`)
  );
}

/** Normalize an epoch-ms number / ISO string / Date to the `number | Date` the DO API accepts. */
function toStorageTime(time: number | string | Date): number | Date {
  if (typeof time === 'number') return time;
  if (time instanceof Date) return time;
  const asNumber = Number(time);
  return time.trim() !== '' && Number.isFinite(asNumber) ? asNumber : new Date(time);
}

/**
 * Read a DO's current bookmark, and — when `time` is given — the bookmark closest
 * to that instant. Throws {@link DoPitrUnavailableError} when a needed method is
 * absent, never `undefined is not a function`.
 */
export async function readDoPitrBookmark(
  storage: DoPitrStorage,
  time?: number | string | Date,
): Promise<DoPitrBookmarkRead> {
  const getCurrent = storage.getCurrentBookmark;
  if (typeof getCurrent !== 'function') throw new DoPitrUnavailableError();
  const current = await getCurrent.call(storage);
  if (time === undefined) return { current };
  const getForTime = storage.getBookmarkForTime;
  if (typeof getForTime !== 'function') throw new DoPitrUnavailableError();
  const forTime = await getForTime.call(storage, toStorageTime(time));
  return { current, forTime };
}

/**
 * Arm a PITR restore. Resolves the target (an explicit `bookmark` WINS over
 * `time`), arms it via `onNextSessionRestoreBookmark`, and returns the undo
 * bookmark the DO reports for the pre-restore state. Does NOT abort — the caller
 * decides whether to restart now. Throws {@link DoPitrUnavailableError} when the
 * arming API (or the by-time resolver a `time` target needs) is absent.
 */
export async function armDoPitr(
  storage: DoPitrStorage,
  opts: DoPitrArmOptions,
): Promise<DoPitrArmResult> {
  const armRestore = storage.onNextSessionRestoreBookmark;
  if (typeof armRestore !== 'function') throw new DoPitrUnavailableError();

  let target: string;
  if (opts.bookmark !== undefined) {
    target = opts.bookmark;
  } else if (opts.time !== undefined) {
    const getForTime = storage.getBookmarkForTime;
    if (typeof getForTime !== 'function') throw new DoPitrUnavailableError();
    target = await getForTime.call(storage, toStorageTime(opts.time));
  } else {
    throw new DoPitrUnavailableError('a target bookmark or time is required to arm a restore');
  }

  const undoBookmark = await armRestore.call(storage, target);
  return { restoredTo: target, undoBookmark, restarted: opts.restart === true };
}
