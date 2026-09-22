import type {
  AnyCacheStore,
  AsyncCacheStore,
  CacheEntryReader,
  CacheEntryWriter,
  CacheEntry,
} from './cache.types';

/**
 * Ordered value tiers. Only entries with known absolute expiry are backfilled;
 * remaining lifetime is preserved. Legacy stores without getEntry still serve
 * reads but are never promoted. Writes/deletes/clears attempt every tier and
 * reject on failure. Mutations through this instance fence in-flight backfills.
 * Direct writes to underlying tiers and distributed replication are outside that fence.
 */
export class TieredCacheStore implements AsyncCacheStore, CacheEntryReader, CacheEntryWriter {
  private readonly tiers: AnyCacheStore[];
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(tiers: AnyCacheStore[]) {
    if (tiers.length === 0) throw new Error('TieredCacheStore requires at least one tier.');
    this.tiers = [...tiers];
  }

  async get(key: string): Promise<unknown> {
    return (await this.getEntry(key))?.value;
  }

  async getEntry(key: string): Promise<{ value: unknown; expiresAt?: number } | undefined> {
    const revision = this.revision;
    await this.pending;
    for (let i = 0; i < this.tiers.length; i++) {
      const tier = this.tiers[i]!;
      const entry = hasEntries(tier) ? await tier.getEntry(key) : { value: await tier.get(key) };
      if (revision !== this.revision) return undefined;
      if (!entry || entry.value === undefined) continue;
      if (
        entry.expiresAt !== undefined &&
        (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now())
      )
        continue;
      if (i > 0 && entry.expiresAt !== undefined) {
        const expiresAt = entry.expiresAt;
        await this.enqueue(async () => {
          if (revision !== this.revision) return;
          for (let j = 0; j < i; j++) {
            const remaining = (expiresAt - Date.now()) / 1000;
            if (remaining <= 0 || revision !== this.revision) return;
            const destination = this.tiers[j]!;
            if (hasEntryWriter(destination))
              await destination.setEntry(key, { value: entry.value, expiresAt });
          }
        });
      }
      if (
        revision !== this.revision ||
        (entry.expiresAt !== undefined && entry.expiresAt <= Date.now())
      )
        return undefined;
      return entry;
    }
    return undefined;
  }

  set(key: string, value: unknown, ttl?: number): Promise<void> {
    return this.mutate((tier) => tier.set(key, value, ttl));
  }
  setEntry(key: string, entry: CacheEntry): Promise<void> {
    return this.mutate((tier) => (hasEntryWriter(tier) ? tier.setEntry(key, entry) : undefined));
  }
  del(key: string): Promise<void> {
    return this.mutate((tier) => tier.del(key));
  }
  clear(): Promise<void> {
    return this.mutate((tier) => tier.clear());
  }
  private mutate(operation: (tier: AnyCacheStore) => unknown): Promise<void> {
    this.revision++;
    return this.enqueue(async () => {
      const results = await Promise.allSettled(this.tiers.map(async (tier) => operation(tier)));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }
}

function hasEntries(store: AnyCacheStore): store is AnyCacheStore & CacheEntryReader {
  return 'getEntry' in store && typeof store.getEntry === 'function';
}

function hasEntryWriter(store: AnyCacheStore): store is AnyCacheStore & CacheEntryWriter {
  return 'setEntry' in store && typeof store.setEntry === 'function';
}
