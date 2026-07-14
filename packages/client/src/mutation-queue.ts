import { VelaLiveError } from './errors';
import type { CommitStamp } from './optimistic';
import type { MutationStore, OfflineQueueOptions, PersistedMutation } from './types';

/**
 * The durable offline mutation queue engine: an in-memory FIFO of pending
 * writes that mirrors each record into a pluggable {@link MutationStore} so a
 * reload can replay them. The queue owns ONLY the ordering, id assignment,
 * store mirroring, overflow eviction and the version/precondition purges; the
 * owning {@link LiveClient} runs the actual HTTP replay, the identity gate, the
 * serializability guard and every terminal-verdict emission. Keeping the socket
 * and HTTP concerns out of here makes the FIFO semantics unit-testable in
 * isolation.
 */

/** One in-flight write. A superset of {@link PersistedMutation}; never stored whole. */
export interface QueuedMutation {
  id: string;
  path: string;
  body?: unknown;
  method?: string;
  headers?: Record<string, string>;
  room?: string;
  /** Issuing-identity fingerprint captured at enqueue (`null` = signed out). */
  identity?: string | null;
  /** OCC / staleness guard evaluated just before replay. */
  precondition?: () => boolean;
  /** True while a live `mutate()` promise still awaits this write; false once hydrated. */
  hadAwaiter: boolean;
  /** Resolve the awaiter (no-op for a hydrated, awaiter-less entry). */
  resolve(value: unknown): void;
  /** Reject the awaiter (no-op for a hydrated entry). */
  reject(error: unknown): void;
  /** Confirm the per-call optimistic layer(s) against the replay's commit stamp (absent for hydrated). */
  onCommit?(stamp: CommitStamp | undefined): void;
}

/** The caller-supplied slice of a live write; the queue assigns the `id`. */
export type EnqueueInput = Omit<QueuedMutation, 'id'>;

export interface MutationQueueDeps {
  maxItems: number;
  /** App/schema version stamped onto persisted records; drives the hydrate purge. */
  version?: string;
  store?: MutationStore;
  /** Fired whenever the pending count changes (drives `pendingMutations()` observers). */
  onSize?: (size: number) => void;
  /** Fired for each entry evicted by overflow, after it was rejected + purged. */
  onEvict?: (entry: QueuedMutation) => void;
  onError?: OfflineQueueOptions['onError'];
}

/**
 * A record whose stamped version no longer matches the current app version is
 * stale: its optimistic assumptions predate a schema change, so it is dropped
 * on hydrate rather than replayed. Absent current version = no gating.
 */
export const isStaleVersion = (current: string | undefined, stamped: string | undefined): boolean =>
  current !== undefined && stamped !== current;

let idCounter = 0;
function nextMutationId(): string {
  const uuid = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  idCounter += 1;
  return `m-${Date.now().toString(36)}-${idCounter}`;
}

export class MutationQueue {
  private readonly entries: QueuedMutation[] = [];
  /** Ids ever held (live or hydrated) — dedups a hydrate against still-pending entries. */
  private readonly known = new Set<string>();

  constructor(private readonly deps: MutationQueueDeps) {}

  get size(): number {
    return this.entries.length;
  }

  /** Append a live write, mirror it to the store, evict the oldest past the cap. */
  enqueue(input: EnqueueInput): QueuedMutation {
    const entry: QueuedMutation = { id: nextMutationId(), ...input };
    this.entries.push(entry);
    this.known.add(entry.id);
    this.persistAppend(entry);
    this.evictOverflow();
    this.emitSize();
    return entry;
  }

  /**
   * Load persisted records after a reload and push them back as awaiter-less
   * entries (durability replay only — the original optimistic transforms and
   * awaiter promise are gone). Dedups against still-pending ids and purges
   * stale-version records. Never re-appends.
   */
  async hydrate(): Promise<void> {
    const store = this.deps.store;
    if (!store) return;
    let records: PersistedMutation[];
    try {
      records = await store.load();
    } catch (error) {
      this.deps.onError?.({ operation: 'load', error });
      return;
    }
    for (const record of records) {
      if (this.known.has(record.id)) continue;
      if (isStaleVersion(this.deps.version, record.version)) {
        this.persistRemove(record.id);
        continue;
      }
      this.known.add(record.id);
      this.entries.push(hydratedEntry(record));
    }
    this.emitSize();
  }

  /**
   * Remove and return every entry whose precondition now fails (the value it
   * assumed changed while offline). The remaining entries keep their FIFO
   * order. Terminal settling (store purge + observer emit + awaiter reject) is
   * the client's job — the client knows these dropped with
   * `OFFLINE_PRECONDITION_FAILED`.
   */
  drainConflict(): QueuedMutation[] {
    const conflicts: QueuedMutation[] = [];
    const kept: QueuedMutation[] = [];
    for (const entry of this.entries) {
      if (entry.precondition !== undefined && entry.precondition() === false) {
        conflicts.push(entry);
        this.known.delete(entry.id);
      } else {
        kept.push(entry);
      }
    }
    if (conflicts.length > 0) {
      this.entries.length = 0;
      this.entries.push(...kept);
      this.emitSize();
    }
    return conflicts;
  }

  /** Remove and return matching entries (default: all), FIFO order preserved. In-memory only. */
  drain(predicate?: (entry: QueuedMutation) => boolean): QueuedMutation[] {
    if (predicate === undefined) {
      const all = this.entries.splice(0, this.entries.length);
      for (const entry of all) this.known.delete(entry.id);
      this.emitSize();
      return all;
    }
    const taken: QueuedMutation[] = [];
    const kept: QueuedMutation[] = [];
    for (const entry of this.entries) {
      if (predicate(entry)) {
        taken.push(entry);
        this.known.delete(entry.id);
      } else {
        kept.push(entry);
      }
    }
    this.entries.length = 0;
    this.entries.push(...kept);
    this.emitSize();
    return taken;
  }

  /** Put entries back at the FRONT (a transport error keeps the FIFO durable for the next flush). */
  requeue(items: QueuedMutation[]): void {
    if (items.length === 0) return;
    for (const entry of items) this.known.add(entry.id);
    this.entries.unshift(...items);
    this.emitSize();
  }

  /** Reject every pending awaiter with `CLIENT_CLOSED`; leave the durable store intact. */
  clear(): void {
    const pending = this.entries.splice(0, this.entries.length);
    for (const entry of pending) {
      this.known.delete(entry.id);
      entry.reject(
        new VelaLiveError('CLIENT_CLOSED', 'client closed before the queued write replayed'),
      );
    }
    this.emitSize();
  }

  /** Drop a durable record after a terminal verdict (committed / rejected / dropped). */
  forget(id: string): void {
    this.persistRemove(id);
  }

  private evictOverflow(): void {
    while (this.entries.length > this.deps.maxItems) {
      const evicted = this.entries.shift();
      if (evicted === undefined) break;
      this.known.delete(evicted.id);
      this.persistRemove(evicted.id);
      this.deps.onEvict?.(evicted);
      evicted.reject(
        new VelaLiveError(
          'OFFLINE_QUEUE_OVERFLOW',
          'offline mutation queue overflowed; oldest write evicted',
        ),
      );
    }
  }

  private persistAppend(entry: QueuedMutation): void {
    const store = this.deps.store;
    if (!store) return;
    const record: PersistedMutation = {
      id: entry.id,
      path: entry.path,
      ...(entry.body === undefined ? {} : { body: entry.body }),
      ...(entry.method === undefined ? {} : { method: entry.method }),
      ...(entry.headers === undefined ? {} : { headers: entry.headers }),
      ...(entry.room === undefined ? {} : { room: entry.room }),
      ...(entry.identity === undefined ? {} : { identity: entry.identity }),
      ...(this.deps.version === undefined ? {} : { version: this.deps.version }),
    };
    Promise.resolve()
      .then(() => store.append(record))
      .catch((error: unknown) => this.deps.onError?.({ operation: 'append', error, id: entry.id }));
  }

  private persistRemove(id: string): void {
    const store = this.deps.store;
    if (!store) return;
    Promise.resolve()
      .then(() => store.remove(id))
      .catch((error: unknown) => this.deps.onError?.({ operation: 'remove', error, id }));
  }

  private emitSize(): void {
    this.deps.onSize?.(this.entries.length);
  }
}

const NOOP = (): void => {};

function hydratedEntry(record: PersistedMutation): QueuedMutation {
  return {
    id: record.id,
    path: record.path,
    body: record.body,
    method: record.method,
    headers: record.headers,
    room: record.room,
    identity: record.identity,
    hadAwaiter: false,
    resolve: NOOP,
    reject: NOOP,
  };
}
