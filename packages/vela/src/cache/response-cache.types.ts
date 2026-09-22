import type { ExecutionContext } from '../pipeline/types';
import type { AnyCacheStore, Awaitable } from './cache.types';

/** Only trusted, authorized identifiers belong here; never credentials or raw client headers. */
export type ResponseCacheScope =
  | { visibility: 'public'; partition: string }
  | { visibility: 'private'; partition: string };

/** Optional generation capability, separate from value storage. Never reuse an old generation. */
export interface CacheInvalidationStore {
  getVersion(key: string): Awaitable<string>;
  invalidate(key: string): Awaitable<void>;
}

export interface ResponseCacheEntryOptions {
  /** Seconds; zero bypasses caching. Default: module TTL (30 seconds). */
  ttl?: number;
  /** Generic labels, always confined to the selected scope. Requires an invalidation store. */
  tags?: readonly string[];
}

export interface CacheResponseOptions extends ResponseCacheEntryOptions {
  /** Additional variant; never replaces the route, origin, query or scope. */
  key?: string;
}

export interface ResponseCacheOptions {
  /** Stable application/deployment namespace; use a different namespace for incompatible schemas. */
  namespace: string;
  store: AnyCacheStore;
  /** Runs after guards. Undefined or a failed resolver bypasses caching. */
  scope: (context: ExecutionContext) => Awaitable<ResponseCacheScope | undefined>;
  invalidation?: CacheInvalidationStore;
  ttl?: number;
  /** Maximum UTF-8 JSON bytes per value; default 64 KiB, maximum 1 MiB. */
  maxBytes?: number;
  /** Optional additional domain check. Never allow secrets merely because a scope is private. */
  shouldCache?: (value: unknown) => boolean;
  /** Observability only. Callback failures are ignored; no raw keys or values are supplied. */
  onError?: (operation: 'read' | 'write' | 'invalidate' | 'scope', error: unknown) => void;
}

/** Failures are reported as data so post-commit invalidation cannot throw a write failure. */
export type CacheInvalidationResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'invalid-input' | 'store-error' };

export interface ScopedResponseCache {
  get(key: string): Promise<unknown>;
  getParsed<T>(key: string, parse: (value: unknown) => T): Promise<T | undefined>;
  set(key: string, value: unknown, options?: ResponseCacheEntryOptions): Promise<boolean>;
  /** Concurrent misses run independently. Consistent generations fence fills started before invalidation. */
  remember<T>(
    key: string,
    load: () => Promise<T>,
    options?: ResponseCacheEntryOptions,
  ): Promise<unknown | T>;
  invalidateKey(key: string): Promise<CacheInvalidationResult>;
  invalidateTags(tags: readonly string[]): Promise<CacheInvalidationResult>;
  invalidateAll(): Promise<CacheInvalidationResult>;
}
