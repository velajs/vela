import type { CacheEntry, CacheStore } from './cache.types';

export class MemoryCacheStore implements CacheStore {
  private store = new Map<string, CacheEntry>();
  private defaultTtl: number;
  private max: number;

  constructor(ttl: number = 5, max: number = 100) {
    this.defaultTtl = ttl;
    this.max = max;
  }

  get(key: string): unknown {
    return this.getEntry(key)?.value;
  }

  getEntry(key: string): CacheEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return { ...entry };
  }

  set(key: string, value: unknown, ttl?: number): void {
    this.setEntry(key, { value, expiresAt: Date.now() + (ttl ?? this.defaultTtl) * 1000 });
  }

  setEntry(key: string, entry: CacheEntry): void {
    // Evict if at capacity
    if (!this.store.has(key) && this.store.size >= this.max) {
      this.evict();
    }
    this.store.set(key, { ...entry });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  private evict(): void {
    // First remove expired entries
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
    // If still at capacity, remove oldest (first inserted)
    if (this.store.size >= this.max) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }
  }
}
