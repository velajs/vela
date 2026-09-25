import { Injectable, Optional } from '../container/decorators';
import type { ThrottlerStore, ThrottlerStorageRecord } from './throttler.types';

interface StoreEntry {
  count: number;
  resetTime: number;
}

export interface ThrottlerStorageOptions {
  /**
   * The most counters kept at once, one per key with an open window. Default
   * 50,000. A key is one route, throttler and client (`ThrottlerGuard` joins
   * the controller, handler, throttler name and tracker), so size it as
   * distinct clients per longest `ttl` × routes each calls × throttlers.
   * Expired windows are evicted first; while every tracked window is still
   * open, a new key is refused (counted over its limit) until one expires,
   * rather than evicting a live counter and resetting its limit.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 50_000;
/** How often expired windows are swept when nothing else prompts it. */
const SWEEP_INTERVAL_MS = 60_000;
/** A full store sweeps for ended windows at most this often. */
const FULL_SWEEP_INTERVAL_MS = 1_000;

/**
 * The default `ThrottlerModule` store: fixed-window counters in this process's
 * memory, per application. Each key's counter lives until its own window
 * (`ttl`) ends, however long, and is then evicted. At most `maxKeys` windows
 * are tracked: when all of them are open, a new key fails closed (refused
 * until a window expires) instead of evicting a counter, so no limit ever
 * resets early. The first refusal logs a warning. Configure one per
 * application with `storage: () => new ThrottlerStorage({ maxKeys })`; an
 * instance in module metadata is shared by every application built from it.
 */
@Injectable()
export class ThrottlerStorage implements ThrottlerStore {
  readonly #entries = new Map<string, StoreEntry>();
  readonly #maxKeys: number;
  #nextSweep = 0;
  #lastSweep = Number.NEGATIVE_INFINITY;
  /** The earliest reset time of a tracked window, when one may have ended. */
  #earliestReset = Number.POSITIVE_INFINITY;
  #warned = false;

  constructor(@Optional() options: ThrottlerStorageOptions = {}) {
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
      throw new RangeError('ThrottlerStorage maxKeys must be a positive integer.');
    }
    this.#maxKeys = maxKeys;
  }

  increment(key: string, ttlMs: number, limit?: number): ThrottlerStorageRecord {
    const now = Date.now();
    if (now >= this.#nextSweep) this.#sweep(now);

    const entry = this.#entries.get(key);
    if (entry !== undefined && now < entry.resetTime) {
      entry.count++;
      return { count: entry.count, ttlMs: entry.resetTime - now };
    }
    if (entry === undefined && this.#entries.size >= this.#maxKeys) {
      // Only an ended window may make room; never a counter still counting.
      if (now >= this.#earliestReset && now - this.#lastSweep >= FULL_SWEEP_INTERVAL_MS) {
        this.#sweep(now);
      }
      if (this.#entries.size >= this.#maxKeys) return this.#refuse(now, limit);
    }

    const resetTime = now + ttlMs;
    this.#entries.set(key, { count: 1, resetTime });
    if (resetTime < this.#earliestReset) this.#earliestReset = resetTime;
    return { count: 1, ttlMs };
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }

  /** Evict every window that has ended, and note the earliest one still open. */
  #sweep(now: number): void {
    let earliest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.#entries) {
      if (now >= entry.resetTime) this.#entries.delete(key);
      else if (entry.resetTime < earliest) earliest = entry.resetTime;
    }
    this.#earliestReset = earliest;
    this.#lastSweep = now;
    this.#nextSweep = now + SWEEP_INTERVAL_MS;
  }

  /** Over-count a key the store has no room for, until the earliest window ends. */
  #refuse(now: number, limit: number | undefined): ThrottlerStorageRecord {
    if (!this.#warned) {
      this.#warned = true;
      console.warn(
        `[vela] ThrottlerStorage is tracking maxKeys (${this.#maxKeys}) open rate-limit windows; ` +
          'requests with new keys are refused until one expires. Raise maxKeys ' +
          '(storage: () => new ThrottlerStorage({ maxKeys })) or use a shared store.',
      );
    }
    return {
      count: limit === undefined ? Number.MAX_SAFE_INTEGER : limit + 1,
      ttlMs: Math.max(1, this.#earliestReset - now),
    };
  }
}
