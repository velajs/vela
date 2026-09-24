import type {
  CacheEntry,
  CacheEntryReader,
  CacheEntryWriter,
  CacheInvalidationStore,
  CacheStore,
} from '@velajs/vela/cache';
import type { EnvFactory } from '@velajs/vela/module-kit';
import { kv } from '../bindings';

/** A KV namespace, or a function that reads it when an operation needs it. */
export type KVNamespaceSource = KVNamespace | (() => KVNamespace);

const namespaceOf = (source: KVNamespaceSource): (() => KVNamespace) =>
  typeof source === 'function' ? source : () => source;

/**
 * Native KV JSON value store. Metadata retains logical expiry even when KV's
 * physical retention rounds up to its 60-second minimum. Legacy values without
 * metadata remain readable, but cannot safely backfill another tier.
 */
export class KVCacheStore implements CacheStore, CacheEntryReader, CacheEntryWriter {
  readonly #namespace: () => KVNamespace;
  constructor(namespace: KVNamespaceSource) {
    this.#namespace = namespaceOf(namespace);
  }

  private get ns(): KVNamespace {
    return this.#namespace();
  }

  async get(key: string): Promise<unknown> {
    return (await this.getEntry(key))?.value;
  }

  async getEntry(key: string): Promise<{ value: unknown; expiresAt?: number } | undefined> {
    const { value, metadata } = await this.ns.getWithMetadata<unknown, unknown>(key, 'json');
    if (value === null) return undefined;
    if (typeof metadata === 'object' && metadata !== null && 'velaCacheExpiresAt' in metadata) {
      const expiresAt = metadata.velaCacheExpiresAt;
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
        return undefined;
      return { value, expiresAt };
    }
    return { value };
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0))
      throw new TypeError('Cache TTL must be finite and nonnegative.');
    if (ttl !== undefined) return this.setEntry(key, { value, expiresAt: Date.now() + ttl * 1000 });
    await this.ns.put(key, JSON.stringify(value));
  }

  async setEntry(key: string, entry: CacheEntry): Promise<void> {
    if (!Number.isFinite(entry.expiresAt)) throw new TypeError('Cache expiry must be finite.');
    const remaining = (entry.expiresAt - Date.now()) / 1000;
    if (remaining <= 0) return this.del(key);
    await this.ns.put(key, JSON.stringify(entry.value), {
      expirationTtl: Math.max(60, Math.ceil(remaining)),
      metadata: { velaCacheExpiresAt: entry.expiresAt },
    });
  }

  async del(key: string): Promise<void> {
    await this.ns.delete(key);
  }

  /** Namespace-wide, best effort. Use a dedicated value namespace; never use for scoped invalidation. */
  async clear(): Promise<void> {
    let cursor: string | undefined;
    do {
      const list = await this.ns.list(cursor ? { cursor } : undefined);
      await Promise.all(list.keys.map((entry) => this.ns.delete(entry.name)));
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }
}

/**
 * Optional, eventually consistent generation store. Use a dedicated KV namespace
 * without TTL/lifecycle cleanup. Never delete/reset generations while entries can
 * survive. Concurrent writes and cached/negative reads prevent strong invalidation;
 * this is unsuitable for strict read-after-write or authorization revocation.
 */
export class KVCacheInvalidationStore implements CacheInvalidationStore {
  readonly #namespace: () => KVNamespace;
  constructor(namespace: KVNamespaceSource) {
    this.#namespace = namespaceOf(namespace);
  }

  private get ns(): KVNamespace {
    return this.#namespace();
  }

  async getVersion(key: string): Promise<string> {
    const value: unknown = await this.ns.get(key, 'json');
    if (value === null) return 'initial';
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048)
      throw new TypeError('Invalid cache generation.');
    return value;
  }
  async invalidate(key: string): Promise<void> {
    await this.ns.put(key, JSON.stringify(crypto.randomUUID()));
  }
}

/**
 * `CacheModule`'s value store over the KV namespace named `binding`, read from
 * each application's `ENV` when an operation needs it:
 * `CacheModule.forRoot({ namespace, scope, store: kvCache({ binding: 'CACHE' }) })`.
 */
export function kvCache(ref: { binding: string }): EnvFactory<CacheStore> {
  const namespace = kv(ref);
  return (env) => new KVCacheStore(() => namespace(env));
}

/**
 * `CacheModule`'s generation store over a dedicated KV namespace named
 * `binding`, without TTLs or lifecycle cleanup. Eventually consistent; see
 * {@link KVCacheInvalidationStore}.
 */
export function kvCacheInvalidation(ref: { binding: string }): EnvFactory<CacheInvalidationStore> {
  const namespace = kv(ref);
  return (env) => new KVCacheInvalidationStore(() => namespace(env));
}
