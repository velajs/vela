import { isClientSeq, isGlobalSeq } from './seq';
import type { EventLogEntry } from './event-log';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate the portable data subset that can actually be deeply frozen. */
export function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    throw new TypeError('Event data must contain only finite JSON values without cycles.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Event data must contain only plain objects and arrays.');
  }
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) assertJson(child, seen);
  seen.delete(value);
}

export function assertEventEntry(value: unknown): asserts value is EventLogEntry {
  if (
    !isRecord(value) ||
    !isGlobalSeq(value.seq) ||
    value.seq === Number.MAX_SAFE_INTEGER ||
    typeof value.type !== 'string' ||
    value.type.length === 0 ||
    typeof value.timestamp !== 'number' ||
    !Number.isFinite(value.timestamp) ||
    (value.parentSeq !== undefined &&
      !isGlobalSeq(value.parentSeq) &&
      !isClientSeq(value.parentSeq)) ||
    (value.clientId !== undefined && typeof value.clientId !== 'string') ||
    (value.sessionId !== undefined && typeof value.sessionId !== 'string')
  )
    throw new TypeError('Invalid event entry.');
  // A payload-less event is supported; undefined inside a payload is not JSON.
  if (value.payload !== undefined) assertJson(value.payload);
  if (value.tableDiffs !== undefined) {
    if (!Array.isArray(value.tableDiffs)) throw new TypeError('Invalid event table diffs.');
    for (const diff of value.tableDiffs) {
      if (
        !isRecord(diff) ||
        typeof diff.table !== 'string' ||
        diff.table.length === 0 ||
        typeof diff.timestamp !== 'number' ||
        !Number.isFinite(diff.timestamp) ||
        !Array.isArray(diff.changes)
      ) {
        throw new TypeError('Invalid event table diff.');
      }
      for (const change of diff.changes) {
        if (
          !isRecord(change) ||
          typeof change.key !== 'string' ||
          typeof change.op !== 'string' ||
          !['insert', 'update', 'delete'].includes(change.op) ||
          (change.op !== 'delete' && !isRecord(change.row))
        ) {
          throw new TypeError('Invalid event row change.');
        }
      }
    }
    assertJson(value.tableDiffs);
  }
}
