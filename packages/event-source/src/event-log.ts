/**
 * An append-only, in-memory log of events — the "what happened" record that
 * every projection replays from.
 *
 * The log assigns a monotonic {@link GlobalSeq} to each entry and auto-wires
 * causal parenting: an entry's `parentSeq` points at the previous head unless
 * the caller overrides it. That seq doubles as a catch-up watermark — a late
 * consumer asks for everything {@link EventLog.getSince | since} its last seq.
 *
 * Durability is out of scope: persist a {@link EventLog.snapshot | snapshot}
 * wherever you like and {@link EventLog.load | load} it back to resume.
 *
 * @module
 */

import type { GlobalSeq, InputEvent, Seq } from './seq';
import type { TableDiff } from './table-diff';
import { assertEventEntry, isRecord } from './validation';

/** A committed, immutable entry in an {@link EventLog}. */
export interface EventLogEntry {
  /** The log-assigned, monotonic position of this entry. */
  readonly seq: GlobalSeq;
  /** Event-type discriminator. */
  readonly type: string;
  /** JSON-serialisable payload. */
  readonly payload: unknown;
  /** Epoch milliseconds when the entry was committed. */
  readonly timestamp: number;
  /**
   * Seq of the causal predecessor: a {@link GlobalSeq} for server-confirmed
   * entries, a `ClientSeq` for optimistic ones, or `undefined` for the first
   * entry in the log.
   */
  readonly parentSeq?: Seq;
  /** Row-level diffs this event produced, if any (lets consumers re-apply
   * without re-running the originating mutation). */
  readonly tableDiffs?: readonly TableDiff[];
  /** Originating client id, when the event came from a client. */
  readonly clientId?: string;
  /** Originating session id, to disambiguate concurrent sessions of a client. */
  readonly sessionId?: string;
}

/** A serialisable capture of the whole log, for persistence or transfer. */
export interface EventLogSnapshot {
  /** Snapshot wire-format version. */
  readonly version: 2;
  /** Stable lineage identifier; changes when a log is cleared or replaced. */
  readonly epoch: string;
  readonly entries: readonly EventLogEntry[];
  /** Seq of the last entry, or `null` when the log is empty. */
  readonly head: GlobalSeq | null;
  /** The seq that will be assigned to the next appended entry. */
  readonly nextSeq: number;
}

/** The minimal event shape {@link EventLog.append} accepts. */
export interface AppendableEvent {
  readonly type: string;
  readonly payload?: unknown;
  readonly timestamp?: number;
  readonly tableDiffs?: readonly TableDiff[];
}

/** Provenance metadata that can ride along on an append. */
export interface AppendOptions {
  /** Override the causal parent (defaults to the current head). */
  readonly parentSeq?: Seq;
  readonly clientId?: string;
  readonly sessionId?: string;
}

export class EventLog {
  #entries: EventLogEntry[] = [];
  #nextSeq = 0;
  #head: GlobalSeq | null = null;
  #epoch: string = crypto.randomUUID();
  #checking = false;

  /**
   * Append one event and return the committed entry. When no `parentSeq` is
   * given, the current head becomes the causal parent.
   */
  append(event: AppendableEvent | InputEvent, options?: AppendOptions): EventLogEntry {
    this.#assertWritable();
    const entry = this.#mint(event, options?.parentSeq ?? this.#head ?? undefined, options);
    this.#nextSeq += 1;
    this.#entries.push(entry);
    this.#head = entry.seq;
    return entry;
  }

  /**
   * Mint and validate an entry before it becomes visible in the log. A throwing
   * check leaves the head and sequence untouched.
   */
  appendChecked(
    event: AppendableEvent | InputEvent,
    check: (entry: EventLogEntry) => void,
    options?: AppendOptions,
  ): EventLogEntry {
    this.#assertWritable();
    const entry = this.#mint(event, options?.parentSeq ?? this.#head ?? undefined, options);
    this.#checking = true;
    try {
      check(entry);
    } finally {
      this.#checking = false;
    }
    this.#nextSeq += 1;
    this.#entries.push(entry);
    this.#head = entry.seq;
    return entry;
  }

  /**
   * Append several events as one causal chain: each entry parents the previous
   * one in the batch, and the first parents the current head (or an explicit
   * `parentSeq`). Validation is atomic: a failed event commits none of the batch.
   * Empty input is a no-op that returns `[]`.
   */
  commitAll(
    events: readonly (AppendableEvent | InputEvent)[],
    options?: AppendOptions,
  ): EventLogEntry[] {
    this.#assertWritable();
    const committed: EventLogEntry[] = [];
    let parent: Seq | undefined = options?.parentSeq ?? this.#head ?? undefined;
    for (const event of events) {
      const entry = this.#mint(event, parent, options, this.#nextSeq + committed.length);
      committed.push(entry);
      parent = entry.seq;
    }
    for (const entry of committed) this.#entries.push(entry);
    this.#nextSeq += committed.length;
    if (committed.length > 0) this.#head = committed[committed.length - 1]!.seq;
    return committed;
  }

  #mint(
    event: AppendableEvent | InputEvent,
    parentSeq: Seq | undefined,
    options: AppendOptions | undefined,
    seq = this.#nextSeq,
  ): EventLogEntry {
    if (!isRecord(event)) throw new TypeError('Invalid event.');
    const entry = {
      seq,
      type: event.type,
      payload: event.payload,
      timestamp: event.timestamp === undefined ? Date.now() : event.timestamp,
      ...(parentSeq !== undefined ? { parentSeq } : {}),
      ...('tableDiffs' in event && event.tableDiffs !== undefined
        ? { tableDiffs: event.tableDiffs }
        : {}),
      ...(options?.clientId !== undefined ? { clientId: options.clientId } : {}),
      ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    };
    assertEventEntry(entry);
    return cloneAndFreeze(entry);
  }

  /** Every entry whose `seq >= sinceSeq`. `sinceSeq <= 0` returns all entries. */
  getSince(sinceSeq: number): readonly EventLogEntry[] {
    if (sinceSeq <= 0) return [...this.#entries];
    const start = this.#entries.findIndex((entry) => entry.seq >= sinceSeq);
    return start === -1 ? [] : this.#entries.slice(start);
  }

  /**
   * A bounded page of entries starting at `fromSeq`, plus a `hasMore` flag for
   * cursoring through a long log.
   */
  getFrom(fromSeq: number, limit = 50): { entries: readonly EventLogEntry[]; hasMore: boolean } {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
      throw new TypeError('EventLog page cursor must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('EventLog page limit must be an integer between 1 and 1000.');
    }
    const start = this.#entries.findIndex((entry) => entry.seq >= fromSeq);
    if (start === -1) return { entries: [], hasMore: false };
    const page = this.#entries.slice(start, start + limit);
    return { entries: page, hasMore: start + limit < this.#entries.length };
  }

  /** Capture the log as a serialisable snapshot. */
  snapshot(): EventLogSnapshot {
    return {
      version: 2,
      epoch: this.#epoch,
      entries: structuredClone(this.#entries),
      head: this.#head,
      nextSeq: this.#nextSeq,
    };
  }

  /** Replace the log contents with a previously captured snapshot. */
  load(snapshot: unknown): void {
    this.#assertWritable();
    validateSnapshot(snapshot);
    this.#entries = snapshot.entries.map((entry) => cloneEntry(entry));
    this.#nextSeq = snapshot.nextSeq;
    this.#head = snapshot.head;
    this.#epoch = snapshot.epoch;
  }

  /** Drop every entry and reset the seq counter. */
  clear(): void {
    this.#assertWritable();
    this.#entries = [];
    this.#nextSeq = 0;
    this.#head = null;
    this.#epoch = crypto.randomUUID();
  }

  #assertWritable(): void {
    if (this.#checking)
      throw new Error('EventLog cannot be modified during appendChecked validation.');
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.#entries.length;
  }

  /** Seq that the next appended entry will receive. */
  get nextSeq(): number {
    return this.#nextSeq;
  }

  /** Seq of the most recent entry, or `null` when empty. */
  get head(): GlobalSeq | null {
    return this.#head;
  }

  /** Trusted lineage/head checkpoint used by bounded projection catch-up. */
  getCheckpoint(): { epoch: string; nextSeq: number } {
    return { epoch: this.#epoch, nextSeq: this.#nextSeq };
  }

  /** `true` when the log holds no entries. */
  get isEmpty(): boolean {
    return this.#entries.length === 0;
  }

  /**
   * Async generator over entries with `seq >= fromSeq` (default all). Present
   * so callers can uniformly `for await` any event source; because the log is
   * purely in-memory it yields the current matching entries and completes.
   */
  async *events(fromSeq = 0): AsyncGenerator<EventLogEntry> {
    for (const entry of this.getSince(fromSeq)) yield entry;
  }
}

const cloneAndFreeze = <T>(value: T): T => deepFreeze(structuredClone(value));

const cloneEntry = (entry: EventLogEntry): EventLogEntry => cloneAndFreeze(entry);

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

function validateSnapshot(snapshot: unknown): asserts snapshot is EventLogSnapshot {
  if (
    !isRecord(snapshot) ||
    snapshot.version !== 2 ||
    typeof snapshot.epoch !== 'string' ||
    snapshot.epoch.length === 0 ||
    new TextEncoder().encode(snapshot.epoch).byteLength > 256
  ) {
    throw new TypeError('Invalid EventLog snapshot version.');
  }
  if (!Array.isArray(snapshot.entries)) throw new TypeError('Invalid EventLog snapshot entries.');
  for (let index = 0; index < snapshot.entries.length; index += 1) {
    const entry = snapshot.entries[index];
    assertEventEntry(entry);
    if (entry.seq !== index) {
      throw new TypeError(`Invalid EventLog snapshot entry at index ${index}.`);
    }
  }
  const expectedHead = snapshot.entries.length === 0 ? null : snapshot.entries.length - 1;
  if (snapshot.head !== expectedHead || snapshot.nextSeq !== snapshot.entries.length) {
    throw new TypeError('Invalid EventLog snapshot head or nextSeq.');
  }
}
