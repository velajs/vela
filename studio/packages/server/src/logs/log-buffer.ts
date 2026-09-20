/**
 * In-memory log ring buffer feeding the `logs.tail` op. M2 provides the buffer
 * + public `record`; the capture wiring (routing framework logs into it) lands
 * in a later milestone.
 */
import type { AdminLogEntry } from '@velajs/studio-protocol';

export class AdminLogBuffer {
  private readonly ring: AdminLogEntry[] = [];

  constructor(private readonly capacity: number) {}

  /** Append a log entry; oldest is evicted past capacity. */
  record(entry: AdminLogEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.shift();
  }

  /** Most-recent entries first, optionally filtered by level and capped at `limit`. */
  tail(options: { level?: AdminLogEntry['level']; limit?: number } = {}): AdminLogEntry[] {
    let entries = this.ring.toReversed();
    if (options.level !== undefined) entries = entries.filter((e) => e.level === options.level);
    return options.limit === undefined ? entries : entries.slice(0, Math.max(0, options.limit));
  }

  /** Current buffered count. */
  get size(): number {
    return this.ring.length;
  }
}
