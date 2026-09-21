import { afterEach, describe, it, expect, vi } from 'vitest';
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
  it('read-through: an L2 hit with known expiry backfills the faster L1', async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new MemoryCacheStore();
    l2.set('k', 'v');

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

afterEach(() => vi.useRealTimers());

describe('tiered expiry and mutation races', () => {
  it('does not backfill stores with unknown expiry', async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new AsyncMapStore();
    await l2.set('key', 1);
    expect(await new TieredCacheStore([l1, l2]).get('key')).toBe(1);
    expect(l1.get('key')).toBeUndefined();
  });

  it('backfills only the remaining lifetime, including exact expiry', async () => {
    vi.useFakeTimers();
    const l1 = new MemoryCacheStore(300);
    const l2 = new MemoryCacheStore();
    l2.set('key', 1, 1);
    vi.advanceTimersByTime(900);
    const cache = new TieredCacheStore([l1, l2]);
    expect(await cache.get('key')).toBe(1);
    expect(l1.getEntry('key')?.expiresAt).toBe(l2.getEntry('key')?.expiresAt);
    vi.advanceTimersByTime(100);
    expect(await cache.get('key')).toBeUndefined();
    expect(l1.get('key')).toBeUndefined();
  });

  it('does not backfill a read that raced with a deletion', async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new MemoryCacheStore();
    l2.set('key', 1);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      get: async () => 1,
      getEntry: async (key: string) => {
        const value = l2.getEntry(key);
        started();
        await gate;
        return value;
      },
      set: async () => {},
      del: async (key: string) => l2.del(key),
      clear: async () => l2.clear(),
    };
    const cache = new TieredCacheStore([l1, slow]);
    const read = cache.get('key');
    await ready;
    await cache.del('key');
    release();
    expect(await read).toBeUndefined();
    expect(l1.get('key')).toBeUndefined();
  });

  it('orders an already-started backfill before deletion', async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new MemoryCacheStore();
    l2.set('key', 1);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowL1 = {
      get: async (key: string) => l1.get(key),
      set: async (key: string, value: unknown, ttl?: number) => l1.set(key, value, ttl),
      setEntry: async (key: string, entry: import('../cache').CacheEntry) => {
        started();
        await gate;
        l1.setEntry(key, entry);
      },
      del: async (key: string) => l1.del(key),
      clear: async () => l1.clear(),
    };
    const cache = new TieredCacheStore([slowL1, l2]);
    const read = cache.get('key');
    await ready;
    const remove = cache.del('key');
    release();
    await remove;
    expect(await read).toBeUndefined();
    expect(l1.get('key')).toBeUndefined();
  });

  it('keeps the original deadline when an async backfill completes after expiry', async () => {
    vi.useFakeTimers();
    const l1 = new MemoryCacheStore();
    const l2 = new MemoryCacheStore();
    l2.set('key', 1, 0.1);
    const slowL1 = {
      get: (key: string) => l1.get(key),
      set: (key: string, value: unknown, ttl?: number) => l1.set(key, value, ttl),
      async setEntry(key: string, entry: import('../cache').CacheEntry) {
        vi.advanceTimersByTime(101);
        l1.setEntry(key, entry);
      },
      del: (key: string) => l1.del(key),
      clear: () => l1.clear(),
    };
    const cache = new TieredCacheStore([slowL1, l2]);
    expect(await cache.get('key')).toBeUndefined();
    expect(l1.get('key')).toBeUndefined();
  });

  it('attempts every tier even when a synchronous store fails', async () => {
    const first = new MemoryCacheStore();
    const second = new MemoryCacheStore();
    first.set = () => {
      throw Error('offline');
    };
    const cache = new TieredCacheStore([first, second]);
    await expect(cache.set('key', 1)).rejects.toThrow('offline');
    expect(second.get('key')).toBe(1);
  });
});
