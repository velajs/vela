import type { EnvFactory } from '../binding';
import type { ExecutionContext } from '../pipeline/types';

/** One named throttler: at most `limit` requests per tracker in each `ttl` window. */
export interface ThrottlerOptions {
  /** The throttler's name. Default `'default'`. */
  name?: string;
  /** Window length in milliseconds. */
  ttl: number;
  /** Requests allowed per tracker in each window. */
  limit: number;
}

/** A route or controller override of one throttler, as `@Throttle({ name: { … } })` takes it. */
export interface ThrottleConfig {
  ttl?: number;
  limit?: number;
}

export interface ThrottlerStorageRecord {
  count: number;
  ttlMs: number;
  /** Optional external allow/deny decision (for platform rate-limit bindings). */
  allowed?: boolean;
  /** Exact remaining quota when the backend exposes it; omit rather than estimate. */
  remaining?: number;
}

export interface ThrottlerStore {
  /**
   * Count one request of `throttlerName` under `key` in a `ttl`-millisecond
   * window allowing `limit` requests.
   */
  increment(
    key: string,
    ttl: number,
    limit: number,
    throttlerName: string,
  ): ThrottlerStorageRecord | Promise<ThrottlerStorageRecord>;
  reset(key: string): void | Promise<void>;
  /**
   * The backend enforces each throttler's declared `ttl` and `limit` itself,
   * as a Workers Rate Limiting binding does, so a `@Throttle()` override that
   * changes them fails instead of being ignored.
   */
  readonly fixedLimits?: boolean;
  /**
   * Check the declared throttlers once, when the application starts: a store
   * that cannot serve one throws, failing bootstrap instead of every request.
   */
  validate?(throttlers: readonly Required<ThrottlerOptions>[]): void;
}

export interface RateLimitInfo {
  limit: number;
  remaining?: number;
  reset: number;
}

export interface ThrottlerModuleOptions {
  /** The named throttlers; each request is counted by every one of them. */
  throttlers: ThrottlerOptions[];
  /**
   * The counter store, or a function that builds it from the application's
   * `ENV` (`rateLimitStore({ binding })` from `@velajs/cloudflare`). Default:
   * a per-application in-memory store.
   */
  storage?: ThrottlerStore | EnvFactory<ThrottlerStore>;
  /**
   * Security-sensitive fallback used only when no framework-trusted identity
   * was published for the request. Prefer a server-verified API key or another
   * stable identifier; never read forwarding headers directly.
   */
  getTracker?: (request: Request, context: ExecutionContext) => string | null | undefined;
  /** The counter key of one tracker and throttler on one route. */
  generateKey?: (context: ExecutionContext, tracker: string, throttlerName: string) => string;
}
