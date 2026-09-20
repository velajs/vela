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
  /** Issuing account+login-epoch fingerprint captured at enqueue. */
  identity: string;
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
  /** Current authenticated account+epoch partition. */
  account: () => string | undefined;
  /** Fired whenever the pending count changes (drives `pendingMutations()` observers). */
  onSize?: (size: number) => void;
  /** Fired for each entry evicted by overflow, after it was rejected + purged. */
  onEvict?: (entry: QueuedMutation) => void;
  /** Fired for each live entry rejected by an explicit account/epoch purge. */
  onIdentityPurge?: (entry: QueuedMutation) => void;
  /** Reject untrusted records loaded from durable storage before they enter memory. */
  validateHydrated?: (record: PersistedMutation) => boolean;
  onInvalidHydrated?: (record: unknown) => void;
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
  /** Login epochs explicitly retired by the owner must never accept new durable writes. */
  private readonly retiredAccounts = new Set<string>();
  /** Serialize persistence operations per account so a late append cannot outrun a logout clear. */
  private readonly storeTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: MutationQueueDeps) {
    if (!Number.isSafeInteger(deps.maxItems) || deps.maxItems < 1 || deps.maxItems > 10_000) {
      throw new VelaLiveError(
        'OFFLINE_QUEUE_OVERFLOW',
        'offline mutation maxItems must be an integer between 1 and 10000',
      );
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** Append a live write, mirror it to the store, evict the oldest past the cap. */
  enqueue(input: EnqueueInput): QueuedMutation {
    if (this.retiredAccounts.has(input.identity)) {
      throw new VelaLiveError(
        'OFFLINE_IDENTITY_PURGED',
        'offline mutations cannot be queued for a retired account epoch',
      );
    }
    const entry: QueuedMutation = { id: nextMutationId(), ...input };
    if (!isPersistedMutation(toPersistedMutation(entry, this.deps.version))) {
      throw new VelaLiveError(
        'OFFLINE_UNSERIALIZABLE',
        'offline mutation exceeds persisted schema or size limits',
      );
    }
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
    const account = this.deps.account();
    if (!isBoundedString(account, 1, 256)) return;
    await this.runStoreTask(account, async () => {
      if (this.retiredAccounts.has(account)) return;
      let loaded: unknown;
      try {
        loaded = await store.load({ account });
      } catch (error) {
        this.deps.onError?.({ operation: 'load', error });
        return;
      }
      // An identity transition may have retired the epoch while storage was loading.
      if (this.retiredAccounts.has(account)) return;
      if (!Array.isArray(loaded)) {
        await this.rewriteStoreUnlocked(store, account, []);
        this.deps.onInvalidHydrated?.(loaded);
        return;
      }
      const overflowed = loaded.length > this.deps.maxItems;
      const candidates = loaded.slice(-this.deps.maxItems);
      const accepted: PersistedMutation[] = [];
      let rejected = overflowed;
      for (const record of candidates) {
        if (!isPersistedMutation(record)) {
          rejected = true;
          this.deps.onInvalidHydrated?.(record);
          continue;
        }
        if (this.known.has(record.id)) continue;
        if (isStaleVersion(this.deps.version, record.version)) {
          rejected = true;
          this.deps.onInvalidHydrated?.(record);
          continue;
        }
        if (this.deps.validateHydrated !== undefined && !this.deps.validateHydrated(record)) {
          rejected = true;
          this.deps.onInvalidHydrated?.(record);
          continue;
        }
        this.known.add(record.id);
        this.entries.push(hydratedEntry(record));
        accepted.push(record);
      }
      if (rejected) await this.rewriteStoreUnlocked(store, account, accepted);
      this.emitSize();
    });
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

  /**
   * Permanently retire one account/login epoch for this queue, reject its live
   * awaiters, and clear its durable partition. Persistence is serialized per
   * account so appends already scheduled before logout complete before the
   * final clear. The clear failure is reported and rethrown to the caller.
   */
  async purgeAccount(account: string): Promise<number> {
    if (!isBoundedString(account, 1, 256)) {
      throw new VelaLiveError(
        'OFFLINE_INVALID_IDENTITY',
        'offline mutation purge requires a non-empty account/login-epoch identity',
      );
    }
    this.retiredAccounts.add(account);
    const pending = this.drain((entry) => entry.identity === account);
    for (const entry of pending) {
      this.deps.onIdentityPurge?.(entry);
      entry.reject(
        new VelaLiveError(
          'OFFLINE_IDENTITY_PURGED',
          'queued mutation was purged during an account identity transition',
        ),
      );
    }

    const store = this.deps.store;
    if (!store) return pending.length;
    try {
      await this.runStoreTask(account, () => store.clear({ account }));
    } catch (error) {
      this.deps.onError?.({ operation: 'clear', error });
      throw new VelaLiveError(
        'OFFLINE_PURGE_FAILED',
        'failed to purge the retired account offline mutation partition',
      );
    }
    return pending.length;
  }

  /** Drop a durable record after a terminal verdict (committed / rejected / dropped). */
  forget(id: string, account: string): void {
    this.persistRemove(id, account);
  }

  private evictOverflow(): void {
    while (this.entries.length > this.deps.maxItems) {
      const evicted = this.entries.shift();
      if (evicted === undefined) break;
      this.known.delete(evicted.id);
      this.persistRemove(evicted.id, evicted.identity);
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
    if (!store || this.retiredAccounts.has(entry.identity)) return;
    const record = toPersistedMutation(entry, this.deps.version);
    void this.runStoreTask(entry.identity, () =>
      store.append(record, { account: entry.identity }),
    ).catch((error: unknown) => this.deps.onError?.({ operation: 'append', error, id: entry.id }));
  }

  private persistRemove(id: string, account: string): void {
    const store = this.deps.store;
    if (!store || this.retiredAccounts.has(account)) return;
    void this.runStoreTask(account, () => store.remove(id, { account })).catch((error: unknown) =>
      this.deps.onError?.({ operation: 'remove', error, id }),
    );
  }

  private emitSize(): void {
    this.deps.onSize?.(this.entries.length);
  }

  private async rewriteStoreUnlocked(
    store: MutationStore,
    account: string,
    records: ReadonlyArray<PersistedMutation>,
  ): Promise<void> {
    try {
      await store.clear({ account });
      for (const record of records) {
        if (this.retiredAccounts.has(account)) return;
        await store.append(record, { account });
      }
    } catch (error) {
      this.deps.onError?.({ operation: 'clear', error });
    }
  }

  /** Run one storage task after all earlier tasks for the same identity partition. */
  private runStoreTask<T>(account: string, task: () => Promise<T>): Promise<T> {
    const previous = this.storeTails.get(account) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.storeTails.set(account, tail);
    void tail.then(() => {
      if (this.storeTails.get(account) === tail) this.storeTails.delete(account);
      return undefined;
    });
    return result;
  }
}

const NOOP = (): void => {};

function hydratedEntry(record: PersistedMutation): QueuedMutation {
  return {
    id: record.id,
    path: record.path,
    body: record.body,
    method: record.method,
    headers: withoutAuthorization(record.headers),
    room: record.room,
    identity: record.identity,
    hadAwaiter: false,
    resolve: NOOP,
    reject: NOOP,
  };
}

const withoutAuthorization = (
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (headers === undefined) return undefined;
  const safe = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  );
  return Object.keys(safe).length === 0 ? undefined : safe;
};

const toPersistedMutation = (
  entry: QueuedMutation,
  version: string | undefined,
): PersistedMutation => ({
  id: entry.id,
  path: entry.path,
  ...(entry.body === undefined ? {} : { body: entry.body }),
  ...(entry.method === undefined ? {} : { method: entry.method }),
  ...(entry.headers === undefined ? {} : { headers: entry.headers }),
  ...(entry.room === undefined ? {} : { room: entry.room }),
  identity: entry.identity,
  ...(version === undefined ? {} : { version }),
});

const isPersistedMutation = (value: unknown): value is PersistedMutation => {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set([
    'id',
    'path',
    'body',
    'method',
    'headers',
    'room',
    'identity',
    'version',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    !isBoundedString(value.id, 1, 256) ||
    !isBoundedString(value.path, 1, 2048) ||
    !isBoundedString(value.identity, 1, 256) ||
    (value.method !== undefined &&
      (!isBoundedString(value.method, 1, 16) || !/^[A-Za-z]+$/.test(value.method))) ||
    (value.room !== undefined && !isBoundedString(value.room, 1, 512)) ||
    (value.version !== undefined && !isBoundedString(value.version, 1, 128)) ||
    (Object.hasOwn(value, 'body') && !isJsonWithin(value.body, 1024 * 1024)) ||
    (value.headers !== undefined && !isSafeHeaders(value.headers))
  ) {
    return false;
  }
  return true;
};

const isSafeHeaders = (value: unknown): value is Record<string, string> => {
  if (!isPlainRecord(value) || Object.keys(value).length > 64) return false;
  let bytes = 0;
  for (const [name, headerValue] of Object.entries(value)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
      name.toLowerCase() === 'authorization' ||
      typeof headerValue !== 'string' ||
      headerValue.length > 8192 ||
      /[\r\n]/.test(headerValue)
    ) {
      return false;
    }
    bytes += name.length + headerValue.length;
  }
  return bytes <= 32 * 1024;
};

const isJsonWithin = (value: unknown, maxBytes: number): boolean => {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index) || !visit(item[index], depth + 1)) return false;
        }
        return true;
      }
      return Object.keys(item).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        return (
          descriptor !== undefined &&
          Object.hasOwn(descriptor, 'value') &&
          visit(descriptor.value, depth + 1)
        );
      });
    } finally {
      seen.delete(item);
    }
  };
  if (!visit(value, 0)) return false;
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && new TextEncoder().encode(encoded).byteLength <= maxBytes;
  } catch {
    return false;
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isBoundedString = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max;
