import type { CacheInvalidationStore } from './cache.types';

/** Bounded, process-local generations. Eviction generates a new version, never resurrecting an entry. */
export class MemoryCacheInvalidationStore implements CacheInvalidationStore {
  private readonly versions = new Map<string, string>();
  constructor(private readonly max = 10000) {
    if (!Number.isInteger(max) || max < 1)
      throw new TypeError('Invalidation capacity must be a positive integer.');
  }
  getVersion(key: string): string {
    const existing = this.versions.get(key);
    if (existing !== undefined) return existing;
    this.invalidate(key);
    return this.versions.get(key)!;
  }
  invalidate(key: string): void {
    if (!this.versions.has(key) && this.versions.size >= this.max)
      this.versions.delete(this.versions.keys().next().value!);
    this.versions.set(key, crypto.randomUUID());
  }
}
