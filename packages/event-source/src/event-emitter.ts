/**
 * A tiny typed event emitter used to fan out runtime signals.
 *
 * The `EventMap` type parameter binds each event name to its payload shape, so
 * `on`/`emit` are checked against the same table. A wildcard channel observes
 * every event. Handler exceptions are swallowed on emit so one bad subscriber
 * cannot break the dispatch loop for the others.
 *
 * @module
 */

/** Handler for a single named event. */
export type Listener<Payload> = (payload: Payload) => void;

/** Handler that observes every event on the emitter. */
export type WildcardListener<EventMap> = <K extends keyof EventMap>(
  event: K,
  payload: EventMap[K],
) => void;

export class EventEmitter<EventMap extends Record<string, unknown>> {
  readonly #named = new Map<keyof EventMap, Set<Listener<unknown>>>();
  readonly #wildcard = new Set<WildcardListener<EventMap>>();

  /**
   * Subscribe to one event. Returns a disposer that removes the handler.
   */
  on<K extends keyof EventMap>(event: K, handler: Listener<EventMap[K]>): () => void {
    let bucket = this.#named.get(event);
    if (bucket === undefined) {
      bucket = new Set();
      this.#named.set(event, bucket);
    }
    bucket.add(handler as Listener<unknown>);
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to one event for a single delivery; the handler is removed right
   * before it runs.
   */
  once<K extends keyof EventMap>(event: K, handler: Listener<EventMap[K]>): () => void {
    const dispose = this.on(event, (payload) => {
      dispose();
      handler(payload);
    });
    return dispose;
  }

  /** Remove a previously registered event handler. */
  off<K extends keyof EventMap>(event: K, handler: Listener<EventMap[K]>): void {
    const bucket = this.#named.get(event);
    bucket?.delete(handler as Listener<unknown>);
    if (bucket?.size === 0) this.#named.delete(event);
  }

  /** Subscribe to every event. Returns a disposer. */
  onAny(handler: WildcardListener<EventMap>): () => void {
    this.#wildcard.add(handler);
    return () => this.#wildcard.delete(handler);
  }

  /** Remove a wildcard handler. */
  offAny(handler: WildcardListener<EventMap>): void {
    this.#wildcard.delete(handler);
  }

  /**
   * Deliver an event to its handlers and every wildcard handler. Returns `true`
   * when at least one handler ran. Thrown errors are caught and dropped.
   */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean {
    let delivered = false;
    const bucket = this.#named.get(event);
    if (bucket !== undefined) {
      // Snapshot the handler set so a subscriber that (un)subscribes during
      // dispatch (e.g. `once`) cannot perturb the loop we are iterating.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const handler of [...bucket]) {
        try {
          handler(payload);
          delivered = true;
        } catch {
          // A subscriber threw; keep dispatching to the rest.
        }
      }
    }
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const handler of [...this.#wildcard]) {
      try {
        handler(event, payload);
        delivered = true;
      } catch {
        // A subscriber threw; keep dispatching to the rest.
      }
    }
    return delivered;
  }

  /** `true` when any handler (named or wildcard) would receive `event`. */
  hasListeners(event: keyof EventMap): boolean {
    return (this.#named.get(event)?.size ?? 0) > 0 || this.#wildcard.size > 0;
  }

  /** Count of handlers registered specifically for `event`. */
  listenerCount(event: keyof EventMap): number {
    return this.#named.get(event)?.size ?? 0;
  }

  /** Drop every subscription. */
  clear(): void {
    this.#named.clear();
    this.#wildcard.clear();
  }
}
