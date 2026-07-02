import { Inject, Injectable, type AsyncCacheStore } from '@velajs/vela';
import { KVService } from './kv.service';

/**
 * Cloudflare KV-backed {@link CacheStore}. Values are JSON-encoded. Intended as
 * the slow tier under a `TieredCacheStore` (memory L1 → KV L2), but usable
 * standalone as `CacheModule.forRootAsync({ inject: [KVService], useFactory: (kv) => ({ store: new KVCacheStore(kv) }) })`.
 *
 * Note: Cloudflare KV requires `expirationTtl >= 60s`, so sub-minute TTLs are
 * clamped up. Keep short TTLs on the memory tier; use KV for longer-lived entries.
 */
@Injectable()
export class KVCacheStore implements AsyncCacheStore {
  constructor(@Inject(KVService) private readonly kv: KVService) {}

  private get ns(): KVNamespace {
    return this.kv.namespace;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = await this.ns.get<T>(key, 'json');
    return value === null ? undefined : value;
  }

  async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
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
