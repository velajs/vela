import type { CommitStamp, CursorLog, ResumeVerdict } from './live.types';

interface LogEntry {
  seq: number;
  tags: string[];
}

const intersects = (a: readonly string[], b: ReadonlySet<string>): boolean =>
  a.some((tag) => b.has(tag));

/**
 * The in-core `CursorLog`: a bounded in-memory ring, epoch minted per process
 * (Web Crypto). A restart rolls the epoch, so every reconnecting client falls
 * back to snapshot — exactly the documented node/dev semantics. Within one
 * process lifetime resume works for gaps the ring still covers; a trimmed gap
 * degrades to snapshot (mirrors lunora's CDC retention rule,
 * `ctx-db-cdc.ts` — retention gap → snapshot).
 *
 * The Cloudflare transport replaces this with a Durable-Object SQLite log so
 * resume survives hibernation and eviction.
 */
export class InMemoryCursorLog implements CursorLog {
  private readonly epoch = crypto.randomUUID();
  private readonly entries: LogEntry[] = [];
  private seq = 0;

  constructor(private readonly maxEntries = 1024) {}

  append(tags: string[]): CommitStamp {
    this.seq += 1;
    this.entries.push({ seq: this.seq, tags });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return { cursor: this.seq, epoch: this.epoch };
  }

  current(): CommitStamp {
    return { cursor: this.seq, epoch: this.epoch };
  }

  evaluateResume(
    sinceCursor: number,
    sinceEpoch: string,
    subscriptionTags: string[],
  ): ResumeVerdict {
    // Forked timeline (restart/reset) — the client's cursor means nothing here.
    if (sinceEpoch !== this.epoch) return 'snapshot';
    // Rollback guard: a cursor from the future is unexplainable.
    if (sinceCursor > this.seq) return 'snapshot';
    if (sinceCursor === this.seq) return 'resume';
    // Retention: the ring must still cover (sinceCursor, seq].
    const oldest = this.entries[0];
    if (oldest === undefined || oldest.seq > sinceCursor + 1) return 'snapshot';

    const subTags = new Set(subscriptionTags);
    for (const entry of this.entries) {
      if (entry.seq <= sinceCursor) continue;
      if (intersects(entry.tags, subTags)) return 'rerun';
    }
    return 'resume';
  }
}
