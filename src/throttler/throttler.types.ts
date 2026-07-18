import type { ExecutionContext } from '../pipeline/types';

export interface ThrottleConfig {
  limit: number;
  ttl: number;
}

export interface ThrottlerStorageRecord {
  count: number;
  ttlMs: number;
  /** Optional external allow/deny decision (for platform rate-limit bindings). */
  allowed?: boolean;
  /** Exact remaining quota when the backend exposes it; omit rather than estimate. */
  remaining?: number;
  /** Fixed limit enforced by the backend; route overrides must match it. */
  enforcedLimit?: number;
}

export interface ThrottlerStore {
  increment(key: string, ttlMs: number): ThrottlerStorageRecord | Promise<ThrottlerStorageRecord>;
  reset(key: string): void | Promise<void>;
}

export interface RateLimitInfo {
  limit: number;
  remaining?: number;
  reset: number;
}

export interface ThrottlerModuleOptions extends ThrottleConfig {
  storage?: ThrottlerStore;
  /**
   * Security-sensitive fallback used only when no framework-trusted identity
   * was published for the request. Prefer a server-verified API key or another
   * stable identifier; never read forwarding headers directly.
   */
  getTracker?: (request: Request, context: ExecutionContext) => string | null | undefined;
  generateKey?: (tracker: string, context: { className: string; handlerName: string }) => string;
}
