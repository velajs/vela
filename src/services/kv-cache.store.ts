import { type AsyncCacheStore } from '@velajs/vela';

/**
 * Cloudflare KV-backed {@link CacheStore}. Values are JSON-encoded. Intended as
 * the slow tier under a `TieredCacheStore` (memory L1 → KV L2), but usable
 * standalone from a typed environment factory: `new KVCacheStore(env.CACHE)`.
 * Reads return unknown JSON; validate values at the consuming boundary.
 *
 * Note: Cloudflare KV requires `expirationTtl >= 60s`, so sub-minute TTLs are
 * clamped up. Keep short TTLs on the memory tier; use KV for longer-lived entries.
 */
export class KVCacheStore implements AsyncCacheStore {
  constructor(private readonly ns: KVNamespace) {}

  async get(key: string): Promise<unknown> {
    const value = await this.ns.get(key, 'json');
    return value === null ? undefined : value;
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    // KV enforces a 60s minimum expirationTtl; clamp up. Omit for no-TTL.
    const options =
      ttl !== undefined ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : undefined;
    await this.ns.put(key, JSON.stringify(value), options);
  }

  async del(key: string): Promise<void> {
    await this.ns.delete(key);
  }

  async clear(): Promise<void> {
    // KV has no native clear — page through and delete. Best-effort.
    let cursor: string | undefined;
    do {
      const list = await this.ns.list(cursor ? { cursor } : undefined);
      await Promise.all(list.keys.map((entry) => this.ns.delete(entry.name)));
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }
}
