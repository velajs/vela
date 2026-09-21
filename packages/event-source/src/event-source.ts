/** Reducer-driven state with source lineage, replay watermarks, and local subscriptions. */
import { EventEmitter } from './event-emitter';
import type { AppendableEvent, AppendOptions, EventLogEntry } from './event-log';
import { EventLog } from './event-log';
import type { InputEvent } from './seq';

/** Returning the same state reference is unhandled; a callback may claim a known no-op. */
export type UnknownEventHandling = 'warn' | 'ignore' | 'fail' | ((entry: EventLogEntry) => boolean);

export type EventSourceEvents = {
  /** Emitted after the first successful replay since construction/reset. */
  ready: { count: number };
  'replay-error': { entry: EventLogEntry; error: Error };
  'state-changed': { entry: EventLogEntry; state: Record<string, unknown> };
  /** Every committed local entry, including deliberately ignored events. */
  'event-applied': { entry: EventLogEntry };
  /** Ends iterators tied to the previous generation. */
  reset: undefined;
};

/** Pure, deterministic reducer; keep external side effects outside replay. */
export type EventReducer<S> = (state: S, entry: EventLogEntry) => S;

export interface EventSourceOptions {
  /** Strategy for unrecognised event types. @default 'fail' */
  unknownEventHandling?: UnknownEventHandling;
}

export class EventSource<S extends Record<string, unknown> = Record<string, unknown>> {
  readonly emitter = new EventEmitter<EventSourceEvents>();
  /** Applied entries, numbered locally. Inspect this log; mutate through EventSource only. */
  readonly log = new EventLog();
  #state: S;
  readonly #reducer: EventReducer<S>;
  readonly #unknownEventHandling: UnknownEventHandling;
  #replayed = false;
  #sourceWatermark = -1;
  #sourceEpoch: string | undefined;
  #busy = false;

  constructor(initialState: S, reducer: EventReducer<S>, options?: EventSourceOptions) {
    this.#state = structuredClone(initialState);
    this.#reducer = reducer;
    this.#unknownEventHandling = options?.unknownEventHandling ?? 'fail';
  }

  get state(): Readonly<S> {
    return this.#state;
  }
  get replayed(): boolean {
    return this.#replayed;
  }
  /** Highest source seq consumed, or -1 before replay. */
  get sourceWatermark(): number {
    return this.#sourceWatermark;
  }
  /** Lineage required alongside a state/watermark checkpoint when resuming. */
  get sourceEpoch(): string | undefined {
    return this.#sourceEpoch;
  }

  applyEvent(event: AppendableEvent | InputEvent, options?: AppendOptions): EventLogEntry {
    return this.#exclusive(() => this.#apply(event, options));
  }

  #apply(
    event: AppendableEvent | InputEvent,
    options?: AppendOptions,
    sourceEntry?: EventLogEntry,
  ): EventLogEntry {
    const rollback = structuredClone(this.#state);
    let next = this.#state;
    let handled = false;
    let candidate: EventLogEntry | undefined;
    let entry: EventLogEntry;
    try {
      entry = this.log.appendChecked(
        event,
        (local) => {
          candidate = sourceEntry ?? local;
          next = this.#reducer(this.#state, candidate);
          handled = next !== this.#state || this.#handleUnknown(candidate);
        },
        options,
      );
    } catch (error) {
      this.#state = rollback;
      const failure = error instanceof Error ? error : new Error(String(error));
      if (candidate) this.emitter.emit('replay-error', { entry: candidate, error: failure });
      throw failure;
    }
    if (handled) this.#state = next;
    // Commit the source watermark before notifying subscribers.
    if (sourceEntry) this.#sourceWatermark = sourceEntry.seq;
    this.emitter.emit('event-applied', { entry });
    if (handled) this.emitter.emit('state-changed', { entry, state: this.#state });
    return entry;
  }

  /** Repeated calls consume only new source entries. A replaced/rewound source requires reset. */
  replayFrom(source: EventLog): void {
    this.#exclusive(() => {
      if (source === this.log)
        throw new Error('EventSource cannot replay its own destination log.');
      const checkpoint = source.getCheckpoint();
      if (
        (this.#sourceEpoch !== undefined && checkpoint.epoch !== this.#sourceEpoch) ||
        this.#sourceWatermark >= checkpoint.nextSeq
      ) {
        throw new Error('EventSource source lineage changed or rewound; reset before replay.');
      }
      this.#sourceEpoch = checkpoint.epoch;
      for (const entry of source.getSince(this.#sourceWatermark + 1)) {
        const expectedSeq = this.#sourceWatermark + 1;
        if (entry.seq !== expectedSeq) {
          throw new Error(
            `EventSource replay gap: expected source seq ${expectedSeq}, received ${entry.seq}.`,
          );
        }
        this.#apply(
          entry,
          {
            ...(entry.parentSeq !== undefined ? { parentSeq: entry.parentSeq } : {}),
            ...(entry.clientId !== undefined ? { clientId: entry.clientId } : {}),
            ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
          },
          entry,
        );
      }
      if (!this.#replayed) {
        this.#replayed = true;
        this.emitter.emit('ready', { count: this.log.size });
      }
    });
  }

  /**
   * Clear applied history and reset state. Resuming requires the original
   * source epoch as well as its highest applied seq, so unrelated logs cannot mix.
   */
  reset(initialState: S, resumeFrom = -1, sourceEpoch?: string): void {
    this.#exclusive(() => {
      if (
        !Number.isSafeInteger(resumeFrom) ||
        resumeFrom < -1 ||
        resumeFrom === Number.MAX_SAFE_INTEGER ||
        (resumeFrom >= 0 && (typeof sourceEpoch !== 'string' || sourceEpoch.length === 0)) ||
        (sourceEpoch !== undefined &&
          (typeof sourceEpoch !== 'string' ||
            sourceEpoch.length === 0 ||
            new TextEncoder().encode(sourceEpoch).byteLength > 256))
      ) {
        throw new TypeError('EventSource resume requires a valid watermark and source epoch.');
      }
      const next = structuredClone(initialState);
      this.log.clear();
      this.#state = next;
      this.#sourceWatermark = resumeFrom;
      this.#sourceEpoch = sourceEpoch;
      this.#replayed = false;
      this.emitter.emit('reset', undefined);
    });
  }

  /**
   * Drain local applied history, then wait for every future commit. Break to
   * unsubscribe; abort to interrupt an outstanding next(). Reset ends the stream.
   * Reads in bounded pages without maintaining a second unbounded event queue.
   */
  async *events(signal?: AbortSignal): AsyncGenerator<EventLogEntry> {
    let wake: (() => void) | undefined;
    const notify = (): void => wake?.();
    const epoch = this.log.getCheckpoint().epoch;
    const done = (): boolean =>
      signal?.aborted === true || this.log.getCheckpoint().epoch !== epoch;
    const unsubscribe = this.emitter.on('event-applied', notify);
    const unsubscribeReset = this.emitter.on('reset', notify);
    signal?.addEventListener('abort', notify, { once: true });
    try {
      let cursor = 0;
      while (!done()) {
        const { entries } = this.log.getFrom(cursor, 500);
        if (entries.length > 0) {
          for (const entry of entries) {
            if (done()) return;
            cursor = entry.seq + 1;
            yield entry;
          }
        } else {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    } finally {
      unsubscribe();
      unsubscribeReset();
      signal?.removeEventListener('abort', notify);
    }
  }

  #exclusive<T>(operation: () => T): T {
    if (this.#busy)
      throw new Error('EventSource cannot be modified during reduction or notification.');
    this.#busy = true;
    try {
      return operation();
    } finally {
      this.#busy = false;
    }
  }

  #handleUnknown(entry: EventLogEntry): boolean {
    const strategy = this.#unknownEventHandling;
    if (typeof strategy === 'function') return strategy(entry);
    if (strategy === 'ignore') return false;
    if (strategy === 'fail') {
      throw new Error(
        `EventSource received an unhandled event type "${entry.type}" at seq ${entry.seq}. Handle it in the reducer or relax unknownEventHandling.`,
      );
    }
    console.warn(
      `[event-source] skipped unhandled event type "${entry.type}" at seq ${entry.seq}.`,
    );
    return false;
  }
}
