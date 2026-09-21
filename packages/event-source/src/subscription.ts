/**
 * A small registry for fan-out to state-change and per-type event subscribers.
 *
 * It is a plain, framework-agnostic building block: wire its `notify*` methods
 * to an {@link EventSource}'s emitter (or call them by hand) and hand the
 * returned disposers to your component teardown. Subscriber exceptions are
 * caught so one listener cannot starve the rest.
 *
 * @module
 */

import type { EventLogEntry } from './event-log';

/** Called with the latest state on every state change. */
export type StateChangeCallback = (state: Readonly<Record<string, unknown>>) => void;

/** Called with each entry whose type matches the subscription. */
export type EventCallback = (entry: EventLogEntry) => void;

type StateRecord = { readonly kind: 'state'; readonly callback: StateChangeCallback };
type EventRecord = {
  readonly kind: 'event';
  readonly type: string;
  readonly callback: EventCallback;
};
type SubscriptionRecord = StateRecord | EventRecord;

export class SubscriptionManager {
  readonly #records = new Map<number, SubscriptionRecord>();
  #nextId = 0;

  /** Subscribe to every state change. Returns a disposer. */
  onStateChange(callback: StateChangeCallback): () => void {
    return this.#add({ kind: 'state', callback });
  }

  /** Subscribe to entries of a specific event `type`. Returns a disposer. */
  onEvent(type: string, callback: EventCallback): () => void {
    return this.#add({ kind: 'event', type, callback });
  }

  #add(record: SubscriptionRecord): () => void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#records.set(id, record);
    return () => {
      this.#records.delete(id);
    };
  }

  /** Deliver `state` to every state-change subscriber. */
  notifyState(state: Readonly<Record<string, unknown>>): void {
    // Snapshot recipients so newly subscribed callbacks wait for the next dispatch.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const record of [...this.#records.values()]) {
      if (record.kind !== 'state') continue;
      try {
        record.callback(state);
      } catch {
        // Keep notifying the remaining subscribers.
      }
    }
  }

  /** Deliver `entry` to subscribers whose type matches `entry.type`. */
  notifyEvent(entry: EventLogEntry): void {
    // Snapshot recipients so newly subscribed callbacks wait for the next dispatch.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const record of [...this.#records.values()]) {
      if (record.kind !== 'event' || record.type !== entry.type) continue;
      try {
        record.callback(entry);
      } catch {
        // Keep notifying the remaining subscribers.
      }
    }
  }

  /** Total active subscriptions. */
  get size(): number {
    return this.#records.size;
  }

  /** Drop every subscription. */
  clear(): void {
    this.#records.clear();
  }
}
