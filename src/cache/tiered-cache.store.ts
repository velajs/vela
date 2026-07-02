import type { AnyCacheStore, AsyncCacheStore } from './cache.types';

/**
 * Composes an ordered list of cache tiers (fastest first, e.g. in-memory L1 →
 * KV L2). Tiers may be sync ({@link CacheStore}) or async ({@link AsyncCacheStore}) —
 * results are awaited uniformly. Reads are read-through: the first tier with a
 * hit wins, and nearer tiers that missed are backfilled. Writes/deletes/clears
 * fan out to all tiers. Always async ({@link AsyncCacheStore}).
 *
 * Runtime-agnostic — the concrete tiers (memory here, KV in `@velajs/cloudflare`)
 * live wherever fits.
 */
export class TieredCacheStore implements AsyncCacheStore {
  private readonly tiers: AnyCacheStore[];

  constructor(tiers: AnyCacheStore[]) {
    if (tiers.length === 0) {
      throw new Error('TieredCacheStore requires at least one tier.');
    }
    this.tiers = tiers;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    for (let i = 0; i < this.tiers.length; i++) {
      const value = (await this.tiers[i]!.get<T>(key)) as T | undefined;
      if (value !== undefined) {
        // Backfill nearer (faster) tiers that missed.
        for (let j = 0; j < i; j++) {
          await this.tiers[j]!.set(key, value);
        }
        return value;
      }
    }
    return undefined;
  }

  async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
    await Promise.all(this.tiers.map((tier) => tier.set(key, value, ttl)));
  }

  async del(key: string): Promise<void> {
    await Promise.all(this.tiers.map((tier) => tier.del(key)));
  }

  async clear(): Promise<void> {
    await Promise.all(this.tiers.map((tier) => tier.clear()));
  }
}
