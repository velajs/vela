/**
 * `defineMaterializer` — a named reducer that derives a view from the log, plus
 * a {@link MaterializerRuntime} that drives a set of them through a
 * snapshot → catch-up → apply lifecycle.
 *
 * A materializer is the durable-projection cousin of {@link EventReducer}: it
 * adds a `name` (its snapshot key) and an `initial()` seed. The runtime holds
 * several, checkpoints their state and watermark as one atomic bundle in a
 * {@link SnapshotStore}, and on restart restores from that checkpoint then
 * replays only the entries after it — so a cold start does not re-fold the
 * whole log.
 *
 * ## At-least-once discipline (read this)
 *
 * The runtime advances its applied watermark as it folds entries, and a
 * checkpoint pairs `{ appliedSeq, state }`. If the process dies **after**
 * applying entries but **before** the next checkpoint, the restart resumes from
 * the older checkpoint and re-applies those entries. Delivery is therefore
 * *at-least-once*: materializer reducers must be pure and deterministic (state is a
 * function of the events folded so far), or any external side effect must be
 * safe to repeat. Persist all materializers together (one {@link
 * MaterializerRuntime.persistSnapshots} call). The store must make a single
 * `save` atomic; adapters that cannot provide that guarantee are not suitable
 * for authorization projections.
 *
 * @module
 */

import type { EventLogEntry } from './event-log';
import type { UnknownEventHandling } from './event-source';
import type { SnapshotStore } from './snapshot-store';
import { assertEventEntry, isRecord } from './validation';

/** Folds an event into the next view state; keep it pure and deterministic. */
export type MaterializerReducer<S> = (state: S, entry: EventLogEntry) => S;

/** The declaration passed to {@link defineMaterializer}. */
export interface MaterializerDef<S> {
  /** Unique name; also the snapshot key. */
  readonly name: string;
  /** Produce the empty starting state. */
  initial(): S;
  /** Reduce one entry into the next state (return the same state to skip). */
  handle: MaterializerReducer<S>;
  /** Parse untrusted checkpoint state. Without this, saved state is rebuilt by replay. */
  parseSnapshot?: (value: unknown) => S;
}

/** A live materializer instance created by {@link defineMaterializer}. */
export interface Materializer<S> {
  readonly def: MaterializerDef<S>;
  /** The current derived state. */
  readonly state: Readonly<S>;
  /** Replace the state (used on snapshot restore). */
  setState(state: S): void;
  /** Validate and replace checkpoint state; throws when no parser is configured. */
  restoreState(value: unknown): void;
  /** Fold one entry into the state. */
  apply(entry: EventLogEntry): void;
  /** Return to the initial state. */
  reset(): void;
}

/** Build a {@link Materializer} from its declaration. */
export const defineMaterializer = <S>(def: MaterializerDef<S>): Materializer<S> => {
  let state = def.initial();
  return {
    def,
    get state(): Readonly<S> {
      return state;
    },
    setState(next: S): void {
      state = next;
    },
    restoreState(value: unknown): void {
      if (!def.parseSnapshot)
        throw new Error(`Materializer "${def.name}" requires parseSnapshot to restore state.`);
      state = def.parseSnapshot(value);
    },
    apply(entry: EventLogEntry): void {
      state = def.handle(state, entry);
    },
    reset(): void {
      state = def.initial();
    },
  };
};

/**
 * A materializer of erased state shape. The runtime holds a heterogeneous set
 * and only ever calls `apply`/`setState`/reads `def.name`, so the concrete `S`
 * is irrelevant — and `Materializer<unknown>` won't do, because `setState(s: S)`
 * makes the type invariant in `S`. Erasing the parameter is the idiomatic fix.
 */
// eslint-disable-next-line typescript/no-explicit-any -- deliberate type erasure for a heterogeneous set; see above.
type AnyMaterializer = Materializer<any>;

/** A trusted source lineage and exclusive upper sequence bound. */
export interface EntrySourceCheckpoint {
  readonly epoch: string;
  readonly nextSeq: number;
}

/** Anything the runtime can page through safely (an {@link EventLog} qualifies). */
export interface EntrySource {
  getCheckpoint(): EntrySourceCheckpoint;
  getFrom(fromSeq: number, limit: number): { entries: readonly EventLogEntry[]; hasMore: boolean };
}

/** Construction options for {@link MaterializerRuntime}. */
export interface MaterializerRuntimeOptions {
  /** Where checkpoints are read/written; omit to run without persistence. */
  snapshotStore?: SnapshotStore;
  /**
   * Key used for the single atomic projection bundle. Set this when multiple
   * runtimes share a store. The default is derived from the ordered names.
   */
  snapshotKey?: string;
  /** Strategy for entries no materializer handled. @default 'fail' */
  unknownEventHandling?: UnknownEventHandling;
  /** Maximum entries returned by one source page. Defaults to 500; maximum 1,000. */
  catchUpPageSize?: number;
  /** Maximum entries one catch-up may fold. Defaults to 10,000. */
  maxCatchUpEntries?: number;
}

interface StoredProjectionBundle {
  readonly version: 2;
  readonly sourceEpoch: string;
  readonly appliedSeq: number;
  readonly states: Readonly<Record<string, unknown>>;
}

export class MaterializerRuntime {
  readonly #materializers: AnyMaterializer[];
  readonly #snapshotStore: SnapshotStore | undefined;
  readonly #snapshotKey: string;
  readonly #unknownEventHandling: UnknownEventHandling;
  readonly #catchUpPageSize: number;
  readonly #maxCatchUpEntries: number;

  /** The next seq the runtime expects to apply (0 = nothing applied yet). */
  #appliedSeq = 0;
  #sourceEpoch: string | undefined;
  #pendingSave: Promise<void> = Promise.resolve();

  constructor(materializers: readonly AnyMaterializer[], options: MaterializerRuntimeOptions = {}) {
    this.#materializers = [...materializers];
    const names = this.#materializers.map((materializer) => materializer.def.name);
    if (names.some((name) => name.length === 0) || new Set(names).size !== names.length) {
      throw new TypeError('Materializer names must be non-empty and unique within a runtime.');
    }
    this.#snapshotStore = options.snapshotStore;
    this.#snapshotKey =
      options.snapshotKey ??
      `@velajs/event-source/materializers/v2/${names.map(encodeURIComponent).join(',')}`;
    if (this.#snapshotKey.length === 0) {
      throw new TypeError('MaterializerRuntime snapshotKey must be non-empty.');
    }
    this.#unknownEventHandling = options.unknownEventHandling ?? 'fail';
    this.#catchUpPageSize = boundedPositiveInteger(
      options.catchUpPageSize ?? 500,
      1000,
      'catchUpPageSize',
    );
    this.#maxCatchUpEntries = boundedPositiveInteger(
      options.maxCatchUpEntries ?? 10_000,
      Number.MAX_SAFE_INTEGER,
      'maxCatchUpEntries',
    );
  }

  /** The next seq to apply; every entry below it has been folded already. */
  get appliedSeq(): number {
    return this.#appliedSeq;
  }

  /** The registered materializers. */
  get materializers(): readonly Materializer<unknown>[] {
    return this.#materializers;
  }

  /**
   * Fold a batch through every materializer. Entries below the watermark are
   * skipped (idempotent), and one that no materializer reacts to triggers the
   * configured unknown-event strategy. Returns how many entries advanced the
   * watermark.
   */
  applyEntries(entries: readonly EventLogEntry[]): number {
    let applied = 0;
    for (const entry of entries) {
      assertEventEntry(entry);
      if (entry.seq < this.#appliedSeq) continue;
      if (entry.seq !== this.#appliedSeq) {
        throw new Error(
          `MaterializerRuntime sequence gap: expected seq ${this.#appliedSeq}, received ${entry.seq}.`,
        );
      }
      const before = this.#materializers.map((m) => m.state);
      // Keep detached rollback values: a buggy reducer may mutate its input
      // before throwing, so retaining references alone is not transactional.
      const rollback = before.map((state) => structuredClone(state));
      try {
        for (const m of this.#materializers) m.apply(entry);
        const reacted = this.#materializers.some((m, index) => m.state !== before[index]);
        if (!reacted) this.#handleUnknown(entry);
      } catch (error) {
        for (let index = 0; index < this.#materializers.length; index += 1) {
          this.#materializers[index]!.setState(rollback[index]);
        }
        throw error;
      }
      this.#appliedSeq = entry.seq + 1;
      applied += 1;
    }
    return applied;
  }

  /**
   * Page from the current watermark through one trusted source checkpoint and
   * fold it. A bounded backlog prevents a cold start from exhausting an edge
   * isolate; restore a trusted projection snapshot or explicitly raise the cap.
   */
  catchUp(source: EntrySource): number {
    const checkpoint = parseSourceCheckpoint(source.getCheckpoint());
    // Direct, unbound delivery cannot prove which source produced its watermark.
    if (this.#sourceEpoch === undefined && this.#appliedSeq > 0) this.reset();
    if (this.#sourceEpoch !== undefined && this.#sourceEpoch !== checkpoint.epoch) {
      this.reset();
    }
    if (this.#appliedSeq > checkpoint.nextSeq) this.reset();
    this.#sourceEpoch = checkpoint.epoch;

    const backlog = checkpoint.nextSeq - this.#appliedSeq;
    if (backlog > this.#maxCatchUpEntries) {
      throw new Error(
        `MaterializerRuntime catch-up backlog ${backlog} exceeds maxCatchUpEntries ${this.#maxCatchUpEntries}.`,
      );
    }

    let applied = 0;
    while (this.#appliedSeq < checkpoint.nextSeq) {
      const expected = this.#appliedSeq;
      const page = source.getFrom(expected, this.#catchUpPageSize);
      if (
        page === null ||
        typeof page !== 'object' ||
        !Array.isArray(page.entries) ||
        typeof page.hasMore !== 'boolean' ||
        page.entries.length === 0 ||
        page.entries.length > this.#catchUpPageSize
      ) {
        throw new Error(
          `MaterializerRuntime source returned an invalid or empty page at seq ${expected}.`,
        );
      }
      const remaining = checkpoint.nextSeq - expected;
      const entries = page.entries.slice(0, remaining);
      for (let index = 0; index < entries.length; index += 1) {
        assertEventEntry(entries[index]);
        if (entries[index]!.seq !== expected + index) {
          throw new Error(
            `MaterializerRuntime sequence gap: expected seq ${expected + index}, received ${entries[index]!.seq}.`,
          );
        }
      }
      applied += this.applyEntries(entries);
    }

    const after = parseSourceCheckpoint(source.getCheckpoint());
    if (after.epoch !== checkpoint.epoch || after.nextSeq < checkpoint.nextSeq) {
      this.reset();
      throw new Error('MaterializerRuntime source lineage changed during catch-up.');
    }
    return applied;
  }

  /**
   * Restore materializer state from the snapshot store and set the watermark to
   * the checkpoint. Returns the resumed watermark (0 with no store or no
   * complete, aligned checkpoint generation). Missing, malformed, or mismatched
   * snapshots trigger a full rebuild instead of skipping projection events.
   */
  async recoverFromSnapshots(): Promise<number> {
    const store = this.#snapshotStore;
    if (store === undefined) return this.#appliedSeq;
    const bundle = parseStoredProjectionBundle(await store.load(this.#snapshotKey));
    if (
      bundle === undefined ||
      this.#materializers.some(
        (materializer) => !Object.hasOwn(bundle.states, materializer.def.name),
      ) ||
      Object.keys(bundle.states).length !== this.#materializers.length
    ) {
      this.reset();
      return 0;
    }
    try {
      for (const materializer of this.#materializers) {
        materializer.restoreState(structuredClone(bundle.states[materializer.def.name]));
      }
    } catch {
      this.reset();
      return 0;
    }
    this.#appliedSeq = bundle.appliedSeq;
    this.#sourceEpoch = bundle.sourceEpoch;
    return bundle.appliedSeq;
  }

  /** Atomically checkpoint every materializer's state and the shared watermark. */
  async persistSnapshots(): Promise<void> {
    const store = this.#snapshotStore;
    if (store === undefined) return;
    if (this.#sourceEpoch === undefined) {
      throw new Error(
        'MaterializerRuntime cannot persist an unbound projection; call catchUp(source) first.',
      );
    }
    const states = Object.create(null) as Record<string, unknown>;
    for (const materializer of this.#materializers) {
      states[materializer.def.name] = structuredClone(materializer.state);
    }
    const bundle = {
      version: 2,
      sourceEpoch: this.#sourceEpoch,
      appliedSeq: this.#appliedSeq,
      states,
    } satisfies StoredProjectionBundle;
    // Calls capture their own state now, but save in order so a slower older
    // checkpoint cannot overwrite a newer one. Failed saves remain retryable.
    const saving = this.#pendingSave.then(() => store.save(this.#snapshotKey, bundle));
    this.#pendingSave = saving.catch(() => {});
    await saving;
  }

  /**
   * The full lifecycle: restore from checkpoints, then catch up from `source`.
   * Returns the number of entries applied during catch-up.
   */
  async bootstrap(source: EntrySource): Promise<number> {
    await this.recoverFromSnapshots();
    return this.catchUp(source);
  }

  /** Reset every materializer and the watermark to a cold start. */
  reset(): void {
    this.#appliedSeq = 0;
    this.#sourceEpoch = undefined;
    for (const m of this.#materializers) m.reset();
  }

  #handleUnknown(entry: EventLogEntry): void {
    const strategy = this.#unknownEventHandling;
    if (typeof strategy === 'function') {
      strategy(entry);
      return;
    }
    if (strategy === 'ignore') return;
    if (strategy === 'fail') {
      throw new Error(
        `MaterializerRuntime received an unhandled event type "${entry.type}" at seq ${entry.seq}. ` +
          'Handle it in a materializer or relax `unknownEventHandling`.',
      );
    }
    console.warn(
      `[event-source] no materializer handled event type "${entry.type}" at seq ${entry.seq}. ` +
        'Set `unknownEventHandling` if this is expected.',
    );
  }
}

const parseStoredProjectionBundle = (value: unknown): StoredProjectionBundle | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<StoredProjectionBundle>;
  if (candidate.version !== 2) return undefined;
  if (
    typeof candidate.sourceEpoch !== 'string' ||
    candidate.sourceEpoch.length === 0 ||
    new TextEncoder().encode(candidate.sourceEpoch).byteLength > 256
  ) {
    return undefined;
  }
  if (!Number.isSafeInteger(candidate.appliedSeq) || (candidate.appliedSeq ?? -1) < 0) {
    return undefined;
  }
  if (!isRecord(candidate.states)) return undefined;
  return {
    version: 2,
    sourceEpoch: candidate.sourceEpoch,
    appliedSeq: candidate.appliedSeq!,
    states: candidate.states,
  };
};

const boundedPositiveInteger = (value: number, max: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`MaterializerRuntime ${label} must be an integer between 1 and ${max}.`);
  }
  return value;
};

const parseSourceCheckpoint = (value: unknown): EntrySourceCheckpoint => {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { epoch?: unknown }).epoch !== 'string' ||
    (value as { epoch: string }).epoch.length === 0 ||
    new TextEncoder().encode((value as { epoch: string }).epoch).byteLength > 256 ||
    !Number.isSafeInteger((value as { nextSeq?: unknown }).nextSeq) ||
    (value as { nextSeq: number }).nextSeq < 0
  ) {
    throw new Error('MaterializerRuntime source returned an invalid checkpoint.');
  }
  return value as EntrySourceCheckpoint;
};
