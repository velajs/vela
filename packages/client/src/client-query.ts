import type { ClientQueryRef, Unsubscribe } from './types';

/**
 * A tiny local-only reactive key/value store, keyed by {@link ClientQueryRef}.
 * Client-owned UI state (filters, drafts, view toggles) that wants the same
 * `useSyncExternalStore` subscription mechanics as a live query but never
 * touches the wire. Snapshots are referentially stable between writes (the
 * stored value, or the ref's `defaultValue` when unset) so React never sees an
 * undefined flash and never tears.
 */
export function createClientQuery<T>(key: string, defaultValue: T): ClientQueryRef<T> {
  return { key, defaultValue };
}

export class ClientQueryStore {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get<T>(ref: ClientQueryRef<T>): T {
    return this.values.has(ref.key) ? (this.values.get(ref.key) as T) : ref.defaultValue;
  }

  set<T>(ref: ClientQueryRef<T>, value: T): void {
    this.values.set(ref.key, value);
    const subscribers = this.listeners.get(ref.key);
    if (subscribers === undefined) return;
    for (const listener of [...subscribers]) {
      try {
        listener();
      } catch {
        // A misbehaving subscriber must not stall the others.
      }
    }
  }

  subscribe<T>(ref: ClientQueryRef<T>, listener: () => void): Unsubscribe {
    let subscribers = this.listeners.get(ref.key);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.listeners.set(ref.key, subscribers);
    }
    subscribers.add(listener);
    return () => {
      const set = this.listeners.get(ref.key);
      if (set === undefined) return;
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(ref.key);
    };
  }
}
