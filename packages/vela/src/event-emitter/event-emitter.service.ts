import { Injectable } from '../container/index';
import type { EventEmitOptions, EventHandler } from './event-emitter.types';

function isWildcard(pattern: string): boolean {
  return pattern.includes('*');
}

function compilePattern(pattern: string): RegExp {
  const regexStr = pattern
    .split('.')
    .map((segment) => {
      if (segment === '**') return '.*';
      if (segment === '*') return '[^.]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('\\.');
  return new RegExp(`^${regexStr}$`);
}

interface Listener {
  handler: EventHandler;
  once: boolean;
  consumed: boolean;
}

interface ListenerBucket {
  handlers: Map<EventHandler, Listener>;
  regex?: RegExp;
}

@Injectable()
export class EventEmitter {
  readonly #exact = new Map<string, ListenerBucket>();
  readonly #wildcard = new Map<string, ListenerBucket>();

  on(event: string, handler: EventHandler): this {
    this.#register(event, handler);
    return this;
  }

  once(event: string, handler: EventHandler): this {
    this.#register(event, handler).once = true;
    return this;
  }

  off(event: string, handler: EventHandler): this {
    const listeners = isWildcard(event) ? this.#wildcard : this.#exact;
    const bucket = listeners.get(event);
    bucket?.handlers.delete(handler);
    if (bucket?.handlers.size === 0) listeners.delete(event);
    return this;
  }

  /** Legacy delivery: concurrent exact handlers, then each matching wildcard group. */
  async emit(event: string, ...args: unknown[]): Promise<void> {
    return this.emitWithOptions(event, { settlement: 'legacy' }, ...args);
  }

  /** Complete delivery attempts the initial listener snapshot and awaits every result. */
  async emitWithOptions(
    event: string,
    options: EventEmitOptions,
    ...args: unknown[]
  ): Promise<void> {
    if (
      options.settlement !== undefined &&
      options.settlement !== 'legacy' &&
      options.settlement !== 'complete'
    ) {
      throw new TypeError('Unknown event settlement policy');
    }
    if (options.settlement === 'complete') {
      const dispatches: Array<() => Promise<void>> = [];
      const exact = this.#exact.get(event);
      if (exact) dispatches.push(...this.#snapshot(event, exact, args));
      for (const [pattern, bucket] of this.#wildcard) {
        if (bucket.regex?.test(event)) dispatches.push(...this.#snapshot(pattern, bucket, args));
      }
      const results = await Promise.allSettled(dispatches.map((dispatch) => dispatch()));
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `Event '${event}' listeners failed`);
      return;
    }
    const exact = this.#exact.get(event);
    if (exact) await Promise.all(this.#snapshot(event, exact, args).map((dispatch) => dispatch()));
    // Snapshot buckets: re-registering the current wildcard during a callback
    // must not append that bucket to this dispatch indefinitely.
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot prevents re-registration loops
    for (const [pattern, bucket] of [...this.#wildcard]) {
      if (!bucket.regex?.test(event)) continue;
      // oxlint-disable-next-line no-await-in-loop -- preserve legacy group ordering
      await Promise.all(this.#snapshot(pattern, bucket, args).map((dispatch) => dispatch()));
    }
  }

  removeAllListeners(event?: string): this {
    if (event) (isWildcard(event) ? this.#wildcard : this.#exact).delete(event);
    else {
      this.#exact.clear();
      this.#wildcard.clear();
    }
    return this;
  }

  listenerCount(event: string): number {
    let count = this.#exact.get(event)?.handlers.size ?? 0;
    for (const bucket of this.#wildcard.values()) {
      if (bucket.regex?.test(event)) count += bucket.handlers.size;
    }
    return count;
  }

  #register(event: string, handler: EventHandler): Listener {
    const wildcard = isWildcard(event);
    const listeners = wildcard ? this.#wildcard : this.#exact;
    let bucket = listeners.get(event);
    if (!bucket) {
      bucket = { handlers: new Map(), ...(wildcard ? { regex: compilePattern(event) } : {}) };
      listeners.set(event, bucket);
    }
    let listener = bucket.handlers.get(handler);
    if (!listener) {
      listener = { handler, once: false, consumed: false };
      bucket.handlers.set(handler, listener);
    }
    return listener;
  }

  #snapshot(event: string, bucket: ListenerBucket, args: unknown[]): Array<() => Promise<void>> {
    return [...bucket.handlers.values()].map((listener) => async () => {
      if (listener.once) {
        // A nested dispatch may have consumed a listener in this snapshot.
        if (listener.consumed) return;
        listener.consumed = true;
        if (bucket.handlers.get(listener.handler) === listener) {
          bucket.handlers.delete(listener.handler);
          const listeners = isWildcard(event) ? this.#wildcard : this.#exact;
          if (bucket.handlers.size === 0 && listeners.get(event) === bucket)
            listeners.delete(event);
        }
      }
      await listener.handler(...args);
    });
  }
}
