import { createStoredFile } from '../internal/stored-file';
import type { OperationOptions, StorageDriver, StoredFile } from '../storage.types';
import { passthrough, type Middleware } from './wrap';

export interface CachedMeta {
  key: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  etag?: string;
  metadata?: Record<string, string>;
}

export interface CacheEntry {
  expiresAt: number;
  kind: 'meta' | 'exists';
  meta?: CachedMeta;
  exists?: boolean;
}

type MaybePromise<T> = T | Promise<T>;

export interface CacheStore {
  get(key: string): MaybePromise<CacheEntry | undefined>;
  set(key: string, value: CacheEntry, ttlMs: number): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
}

/** In-memory, per-isolate cache with lazy TTL + insertion-order eviction (no timers). */
export class MapCacheStore implements CacheStore {
  #map = new Map<string, CacheEntry>();
  constructor(
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {}
  get(key: string): CacheEntry | undefined {
    const e = this.#map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.#map.delete(key);
      return undefined;
    }
    return e;
  }
  set(key: string, value: CacheEntry): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.maxEntries) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
  }
  delete(key: string): void {
    this.#map.delete(key);
  }
}

export interface CacheOptions {
  store?: CacheStore;
  ttlMs?: number;
  /** Which reads to cache. Default: head + exists (body/list are not cached). */
  cache?: { head?: boolean; exists?: boolean };
  keyPrefix?: string;
  now?: () => number;
}

function toMeta(f: StoredFile): CachedMeta {
  return {
    key: f.key,
    name: f.name,
    size: f.size,
    type: f.type,
    lastModified: f.lastModified,
    etag: f.etag,
    metadata: f.metadata,
  };
}

/**
 * Read-through cache for `head` / `exists`. Bodies are never cached (a `head`
 * hit still lazily fetches on body access), and `list` is not cached
 * (cross-prefix invalidation is intractable). Writes invalidate the key.
 */
export function cache(opts: CacheOptions = {}): Middleware {
  const now = opts.now ?? Date.now;
  const store = opts.store ?? new MapCacheStore(1000, now);
  const ttl = opts.ttlMs ?? 60_000;
  const doHead = opts.cache?.head ?? true;
  const doExists = opts.cache?.exists ?? true;
  const ns = (k: string) => `${opts.keyPrefix ?? ''}${k}`;

  return (inner) => {
    const invalidate = async (...keys: string[]) => {
      await Promise.all(keys.map((k) => store.delete(ns(k))));
    };
    return passthrough(inner, {
      head: doHead
        ? async (k: string, o?: OperationOptions): Promise<StoredFile> => {
            const hit = await store.get(ns(k));
            if (hit?.kind === 'meta' && hit.meta) {
              return createStoredFile(hit.meta, {
                kind: 'lazy',
                fetch: async () => new Response((await inner.download(k)).stream()),
              });
            }
            const file = await inner.head(k, o);
            await store.set(
              ns(k),
              { kind: 'meta', meta: toMeta(file), expiresAt: now() + ttl },
              ttl,
            );
            return file;
          }
        : undefined,
      exists: doExists
        ? async (k: string, o?: OperationOptions): Promise<boolean> => {
            const hit = await store.get(ns(k));
            if (hit?.kind === 'exists' && typeof hit.exists === 'boolean') return hit.exists;
            const exists = await inner.exists(k, o);
            await store.set(ns(k), { kind: 'exists', exists, expiresAt: now() + ttl }, ttl);
            return exists;
          }
        : undefined,
      upload: async (k, b, o) => {
        const r = await inner.upload(k, b, o);
        await invalidate(k);
        return r;
      },
      delete: async (k, o) => {
        await inner.delete(k, o);
        await invalidate(k);
      },
      copy: async (f, t, o) => {
        await inner.copy(f, t, o);
        await invalidate(t);
      },
    } satisfies Partial<StorageDriver>);
  };
}
