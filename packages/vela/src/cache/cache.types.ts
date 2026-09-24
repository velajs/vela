/** A value that may be returned synchronously or as a promise. */
export type Awaitable<T> = T | Promise<T>;

export interface CacheModuleOptions {
  ttl?: number; // default TTL in seconds (default: 5)
  max?: number; // max entries (default: 100)
  /** Register `CacheInterceptor` application-wide (`APP_INTERCEPTOR`). Structural. */
  globalInterceptor?: boolean;
  /**
   * Resolve the authenticated principal/tenant partition for a request.
   * Credential-bearing requests are cached only when this returns a non-empty
   * value. The value is SHA-256 hashed before it becomes part of the cache key.
   * Throwing, returning an empty value, or returning an oversized value safely
   * bypasses caching.
   */
  varyBy?: (request: Request) => Awaitable<string | undefined>;
  /**
   * Custom SYNC backing store (replaces the default in-memory store). For async
   * (KV/tiered) response caching use `ResponseCacheModule` + `@CacheResponse()`.
   * The legacy CacheService/CacheInterceptor path stays synchronous.
   */
  store?: CacheStore;
}

/**
 * Synchronous cache backing store. Reads return unknown; validate persisted
 * values at the consuming boundary. Undefined represents a cache miss.
 */
export interface CacheStore {
  get(key: string): unknown;
  set(key: string, value: unknown, ttl?: number): void;
  del(key: string): void;
  clear(): void;
}

/**
 * Asynchronous cache backing store (additive). Implemented by remote/tiered
 * stores (`TieredCacheStore`, and `KVCacheStore` in `@velajs/cloudflare`) where
 * reads/writes are inherently async. Use ResponseCacheModule for response caching
 * or inject it under your own token, never the synchronous CACHE_MANAGER.
 */
export interface AsyncCacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** A store that may be sync or async (used to compose tiers). */
export type AnyCacheStore = CacheStore | AsyncCacheStore;

export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

/** Optional read capability used for expiry-preserving tier backfill. Unknown expiry is never backfilled. */
export interface CacheEntryReader {
  getEntry(key: string): Awaitable<{ value: unknown; expiresAt?: number } | undefined>;
}

/** Optional absolute-expiry write capability. Required on destination tiers for safe backfill. */
export interface CacheEntryWriter {
  setEntry(key: string, entry: CacheEntry): Awaitable<void>;
}
