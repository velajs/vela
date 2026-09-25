import type { EnvFactory } from '../binding';
import type { ExecutionContext } from '../pipeline/types';

/** A value that may be returned synchronously or as a promise. */
export type Awaitable<T> = T | Promise<T>;

/**
 * A cache backing store, synchronous (memory) or asynchronous (KV, tiered).
 * Reads return unknown; validate persisted values at the consuming boundary.
 * Undefined represents a miss.
 */
export interface CacheStore {
  get(key: string): Awaitable<unknown>;
  set(key: string, value: unknown, ttl?: number): Awaitable<void>;
  del(key: string): Awaitable<void>;
  clear(): Awaitable<void>;
}

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

/** Only trusted, authorized identifiers belong here; never credentials or raw client headers. */
export type CacheScope =
  | { visibility: 'public'; partition: string }
  | { visibility: 'private'; partition: string };

/** Optional generation capability, separate from value storage. Never reuse an old generation. */
export interface CacheInvalidationStore {
  getVersion(key: string): Awaitable<string>;
  invalidate(key: string): Awaitable<void>;
}

export interface CacheEntryOptions {
  /** Seconds; zero bypasses caching. Default: module TTL (30 seconds). */
  ttl?: number;
  /** Generic labels, always confined to the selected scope. Requires an invalidation store. */
  tags?: readonly string[];
}

export interface CacheResponseOptions extends CacheEntryOptions {
  /** Additional variant; never replaces the route, origin, query or scope. */
  key?: string;
}

export interface CacheModuleOptions {
  /**
   * Stable application/deployment namespace. A `@CacheResponse` hit replays
   * the stored response without parsing it again, so use a different
   * namespace when a route's `response` schema is tightened or becomes
   * incompatible, or entries stored under the earlier schema are served until
   * they expire.
   */
  namespace: string;
  /** Runs after guards. Undefined or a failed resolver bypasses caching. */
  scope: (context: ExecutionContext) => Awaitable<CacheScope | undefined>;
  /**
   * The value store, or a function that builds it from the application's
   * `ENV` (`kvCache({ binding: 'CACHE' })` from `@velajs/cloudflare`).
   * Default: a per-application in-memory store holding `max` entries.
   */
  store?: CacheStore | EnvFactory<CacheStore>;
  /** Optional generation store for tags and invalidation, or a function of `ENV`. */
  invalidation?: CacheInvalidationStore | EnvFactory<CacheInvalidationStore>;
  /** Default entry lifetime in seconds. Default 30. */
  ttl?: number;
  /** Capacity of the default in-memory store. Default 1000; ignored with `store`. */
  max?: number;
  /**
   * Maximum UTF-8 bytes per value's JSON or route response body; default
   * 64 KiB, maximum 1 MiB.
   */
  maxBytes?: number;
  /**
   * Optional additional domain check: a value, or the body a route sends,
   * JSON-decoded. Never allow secrets merely because a scope is private.
   */
  shouldCache?: (value: unknown) => boolean;
  /**
   * Observability only, called after the application's error reporter (edge
   * `'cache'`) receives the same failure. Callback failures are ignored; no
   * raw keys or values are supplied.
   */
  onError?: (operation: 'read' | 'write' | 'invalidate' | 'scope', error: unknown) => void;
}

/** The options a {@link CacheModuleOptions} resolves to for one application. */
export interface ResolvedCacheOptions extends Omit<CacheModuleOptions, 'store' | 'invalidation'> {
  store: CacheStore;
  invalidation?: CacheInvalidationStore;
}

/** Failures are reported as data so post-commit invalidation cannot throw a write failure. */
export type CacheInvalidationResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'invalid-input' | 'store-error' };

export interface ScopedCache {
  get(key: string): Promise<unknown>;
  getParsed<T>(key: string, parse: (value: unknown) => T): Promise<T | undefined>;
  set(key: string, value: unknown, options?: CacheEntryOptions): Promise<boolean>;
  /** Concurrent misses run independently. Consistent generations fence fills started before invalidation. */
  remember<T>(
    key: string,
    load: () => Promise<T>,
    options?: CacheEntryOptions,
  ): Promise<unknown | T>;
  invalidateKey(key: string): Promise<CacheInvalidationResult>;
  invalidateTags(tags: readonly string[]): Promise<CacheInvalidationResult>;
  invalidateAll(): Promise<CacheInvalidationResult>;
}
