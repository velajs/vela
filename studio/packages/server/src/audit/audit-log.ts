/**
 * In-memory audit ring buffer. Every dispatch records one {@link AdminAuditEntry}
 * (read and write). An optional {@link AdminAuditSink} mirror is called
 * best-effort — a throwing/rejecting sink never breaks a request.
 */
import type { AdminAuditEntry } from '@velajs/studio-protocol';
import type { AdminAuditSink } from '../tokens';

export class AdminAuditLog {
  private readonly ring: AdminAuditEntry[] = [];

  constructor(
    private readonly capacity: number,
    private readonly sink?: AdminAuditSink,
  ) {}

  /** Append an entry; oldest is evicted past capacity. Mirrors to the sink best-effort. */
  record(entry: AdminAuditEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.shift();
    if (this.sink) {
      try {
        void Promise.resolve(this.sink.write(entry)).catch(() => {});
      } catch {
        // best-effort: a synchronous sink throw must never surface to the request
      }
    }
  }

  /** Most-recent entries first, capped at `limit` (default = full buffer). */
  tail(limit?: number): AdminAuditEntry[] {
    const reversed = this.ring.toReversed();
    return limit === undefined ? reversed : reversed.slice(0, Math.max(0, limit));
  }

  /** Current buffered count. */
  get size(): number {
    return this.ring.length;
  }
}
