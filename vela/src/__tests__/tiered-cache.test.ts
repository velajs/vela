import { describe, it, expect } from 'vitest';
import { MemoryCacheStore, TieredCacheStore, type AsyncCacheStore } from '../cache/index.js';

// Minimal async store to exercise the promise path (mimics a KV-backed tier).
class AsyncMapStore implements AsyncCacheStore {
  private readonly map = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.map.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
}

describe('TieredCacheStore', () => {
  it('read-through: an L2 hit backfills the faster L1', async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new AsyncMapStore();
    await l2.set('k', 'v');

    const tiered = new TieredCacheStore([l1, l2]);
    expect(await tiered.get('k')).toBe('v');
    // L1 (sync memory) now holds the backfilled value.
    expect(l1.get('k')).toBe('v');
  });

  it('write-through: set fans out to every tier', async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new AsyncMapStore();
    const tiered = new TieredCacheStore([l1, l2]);

    await tiered.set('k', 42);
    expect(l1.get('k')).toBe(42);
    expect(await l2.get('k')).toBe(42);
  });

  it('returns undefined on a full miss; del/clear fan out', async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new AsyncMapStore();
    const tiered = new TieredCacheStore([l1, l2]);

    expect(await tiered.get('missing')).toBeUndefined();

    await tiered.set('k', 1);
    await tiered.del('k');
    expect(l1.get('k')).toBeUndefined();
    expect(await l2.get('k')).toBeUndefined();

    await tiered.set('a', 1);
    await tiered.clear();
    expect(l1.get('a')).toBeUndefined();
    expect(await l2.get('a')).toBeUndefined();
  });

  it('requires at least one tier', () => {
    expect(() => new TieredCacheStore([])).toThrow(/at least one/i);
  });
});
