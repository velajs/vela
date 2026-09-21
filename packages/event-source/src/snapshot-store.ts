/**
 * Persistence seam for materialized state snapshots.
 *
 * {@link SnapshotStore} is a small async key/value contract so a materializer
 * runtime can checkpoint its state and skip re-deriving from the top of the log
 * on every restart. Where the bytes actually live — a Durable Object, IndexedDB,
 * OPFS, a file — is the adapter's concern. An {@link InMemorySnapshotStore}
 * ships for tests and ephemeral use.
 *
 * @module
 */

export interface SnapshotStore {
  /**
   * Persist `snapshot` under `key`, overwriting any prior value atomically.
   * Security-sensitive projection state and its watermark are stored together
   * in this single value; adapters must never expose a partial write.
   */
  save(key: string, snapshot: unknown): Promise<void>;
  /** Load the snapshot at `key`, or `null` when there is none. */
  load(key: string): Promise<unknown | null>;
  /** Every key currently held. */
  list(): Promise<string[]>;
  /** Remove the snapshot at `key` (no-op when absent). */
  delete(key: string): Promise<void>;
  /** Remove every snapshot. */
  clear(): Promise<void>;
}

/**
 * A {@link SnapshotStore} backed by a `Map`. Values are deep-copied via
 * `structuredClone` on the way in and out, so a caller cannot mutate stored
 * state through a lingering reference. `null` is reserved to mean "absent",
 * letting a stored `undefined` still round-trip distinctly.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  readonly #store = new Map<string, unknown>();

  save(key: string, snapshot: unknown): Promise<void> {
    this.#store.set(key, structuredClone(snapshot));
    return Promise.resolve();
  }

  load(key: string): Promise<unknown | null> {
    if (!this.#store.has(key)) return Promise.resolve(null);
    return Promise.resolve(structuredClone(this.#store.get(key)));
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.#store.keys()]);
  }

  delete(key: string): Promise<void> {
    this.#store.delete(key);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#store.clear();
    return Promise.resolve();
  }
}
