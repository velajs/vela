/**
 * Application-owned bounded log history. The optional logging module subscribes
 * to the application's structured logger; manual record() remains supported.
 */
import type { AdminLogEntry } from '@velajs/studio-protocol';
import { isRecord } from '@velajs/studio-protocol';
import { diagnosticSnapshot } from '../introspect/snapshot';

function copyEntry(entry: AdminLogEntry): AdminLogEntry {
  const fields = entry.fields === undefined ? undefined : diagnosticSnapshot(entry.fields);
  return {
    ts: entry.ts,
    level: entry.level,
    msg: entry.msg.slice(0, 2_048),
    ...(entry.source === undefined ? {} : { source: entry.source.slice(0, 2_048) }),
    ...(fields === undefined ? {} : { fields: isRecord(fields) ? fields : { snapshot: fields } }),
    ...(entry.invocation === undefined ? {} : { invocation: { ...entry.invocation } }),
  };
}

export class AdminLogBuffer {
  #ring: AdminLogEntry[] = [];
  readonly #capacity: number;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw new RangeError('Log buffer capacity must be a nonnegative safe integer');
    }
    this.#capacity = capacity;
  }

  /** Append a log entry; oldest is evicted past capacity. */
  record(entry: AdminLogEntry): void {
    if (this.#capacity === 0) return;
    this.#ring.push(copyEntry(entry));
    if (this.#ring.length > this.#capacity) this.#ring.shift();
  }

  /** Most-recent entries first, optionally filtered by level and capped at `limit`. */
  tail(options: { level?: AdminLogEntry['level']; limit?: number } = {}): AdminLogEntry[] {
    let entries = this.#ring.toReversed();
    if (options.level !== undefined) entries = entries.filter((e) => e.level === options.level);
    if (options.limit !== undefined) entries = entries.slice(0, Math.max(0, options.limit));
    return entries.map(copyEntry);
  }

  /** Current buffered count. */
  get size(): number {
    return this.#ring.length;
  }
}
