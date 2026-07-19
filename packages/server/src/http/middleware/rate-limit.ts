/**
 * Two per-client-IP limiters guarding the admin surface:
 *
 *  - {@link FixedWindowCounter} — a cheap, crypto-free fixed-window request
 *    counter that runs BEFORE bearer verification. It exists to blunt
 *    pre-auth floods (unauthenticated request spam / bearer brute-forcing)
 *    without spending a constant-time compare on every packet. Its limit is
 *    intentionally generous (see the admin router: 5× the post-auth `max`) so
 *    legitimate use never trips it.
 *  - {@link RateLimiter} — the post-auth token bucket (capacity `max`, refilling
 *    `max` tokens per `windowMs` continuously) applied once a caller is
 *    authenticated.
 *
 * Both are pure and clock-injectable so tests drive them deterministically, and
 * both bound their key map: a distinct spoofed IP costs one entry, so an
 * attacker cycling source IPs could otherwise grow the map without limit. On
 * insert, when the map exceeds `maxEntries`, entries idle longer than `windowMs`
 * are evicted (a simple scan). An idle token-bucket has fully refilled and an
 * idle fixed-window has rolled over, so evicting them is lossless. The admin
 * router maps a denial from either to 429 `STUDIO_RATE_LIMITED`.
 */

/** Default cap on distinct keys retained by either limiter map. */
export const DEFAULT_MAX_ENTRIES = 10_000;

/** Monotonic-ish clock in ms; injectable for tests. */
export type Clock = () => number;

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Max distinct keys retained before idle eviction kicks in. Default {@link DEFAULT_MAX_ENTRIES}. */
  maxEntries?: number;
}

/**
 * Evict entries whose last-touch timestamp is older than `windowMs`, but only
 * when the map is over `maxEntries`. Idle entries are safe to drop (a token
 * bucket has fully refilled; a fixed window has rolled over), so a fresh entry
 * for the same key reconstructs an equivalent state.
 */
function evictIdle(
  map: Map<string, { last: number }>,
  now: number,
  windowMs: number,
  maxEntries: number,
): void {
  if (map.size <= maxEntries) return;
  for (const [key, entry] of map) {
    if (now - entry.last > windowMs) map.delete(key);
  }
}

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly options: RateLimitOptions,
    private readonly clock: Clock = () => Date.now(),
  ) {
    this.refillPerMs = options.max / options.windowMs;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Consume one token for `key`. Returns true when allowed, false when limited. */
  check(key: string): boolean {
    const now = this.clock();
    const bucket = this.buckets.get(key) ?? { tokens: this.options.max, last: now };
    const elapsed = Math.max(0, now - bucket.last);
    bucket.tokens = Math.min(this.options.max, bucket.tokens + elapsed * this.refillPerMs);
    bucket.last = now;

    let allowed = false;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    }
    this.buckets.set(key, bucket);
    evictIdle(this.buckets, now, this.options.windowMs, this.maxEntries);
    return allowed;
  }

  /** Number of retained keys (test / introspection aid). */
  get size(): number {
    return this.buckets.size;
  }

  /** Drop all buckets (test aid / memory hygiene). */
  reset(): void {
    this.buckets.clear();
  }
}

interface WindowEntry {
  count: number;
  /** Window start = last-touch for eviction purposes. */
  last: number;
}

/**
 * Fixed-window per-key request counter: at most `max` requests per rolling
 * `windowMs` slot. No crypto, no token-bucket arithmetic — one map lookup and an
 * increment. Used as the pre-auth throttle.
 */
export class FixedWindowCounter {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly maxEntries: number;

  constructor(
    private readonly options: RateLimitOptions,
    private readonly clock: Clock = () => Date.now(),
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Count one request for `key`. Returns true when under the window limit, false when over. */
  check(key: string): boolean {
    const now = this.clock();
    let entry = this.entries.get(key);
    if (!entry || now - entry.last >= this.options.windowMs) {
      entry = { count: 0, last: now };
    }
    entry.count += 1;
    const allowed = entry.count <= this.options.max;
    this.entries.set(key, entry);
    evictIdle(this.entries, now, this.options.windowMs, this.maxEntries);
    return allowed;
  }

  /** Number of retained keys (test / introspection aid). */
  get size(): number {
    return this.entries.size;
  }

  /** Drop all windows (test aid / memory hygiene). */
  reset(): void {
    this.entries.clear();
  }
}
