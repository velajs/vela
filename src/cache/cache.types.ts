/** A value that may be returned synchronously or as a promise. */
export type Awaitable<T> = T | Promise<T>;

export interface CacheModuleOptions {
  ttl?: number; // default TTL in seconds (default: 5)
  max?: number; // max entries (default: 100)
  isGlobal?: boolean; // register CacheInterceptor as APP_INTERCEPTOR
  /**
   * Custom SYNC backing store (replaces the default in-memory store). For async
   * (KV/tiered) caching use {@link AsyncCacheStore} + `TieredCacheStore`
   * programmatically — the interceptor/CacheService path is synchronous.
   */
  store?: CacheStore;
}

/**
 * Synchronous cache backing store. This is the original, stable contract used by
 * `CacheService` and `CacheInterceptor` — unchanged.
 */
export interface CacheStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T, ttl?: number): void;
  del(key: string): void;
  clear(): void;
}

/**
 * Asynchronous cache backing store (additive). Implemented by remote/tiered
 * stores (`TieredCacheStore`, and `KVCacheStore` in `@velajs/cloudflare`) where
 * reads/writes are inherently async. Use it programmatically — inject the store
 * under your own token — rather than as the synchronous `CACHE_MANAGER`.
 */
export interface AsyncCacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** A store that may be sync or async (used to compose tiers). */
export type AnyCacheStore = CacheStore | AsyncCacheStore;

export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}
