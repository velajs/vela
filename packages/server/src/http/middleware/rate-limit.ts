/**
 * Per-client-IP token-bucket rate limiter. Capacity `max`, refilling `max`
 * tokens per `windowMs` continuously. Pure and clock-injectable so tests drive
 * it deterministically; the admin router maps a denial to 429
 * `STUDIO_RATE_LIMITED`.
 */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/** Monotonic-ish clock in ms; injectable for tests. */
export type Clock = () => number;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;

  constructor(
    private readonly options: RateLimitOptions,
    private readonly clock: Clock = () => Date.now(),
  ) {
    this.refillPerMs = options.max / options.windowMs;
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
    return allowed;
  }

  /** Drop all buckets (test aid / memory hygiene). */
  reset(): void {
    this.buckets.clear();
  }
}
