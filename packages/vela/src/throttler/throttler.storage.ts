import { Injectable } from '../container/decorators';
import type { ThrottlerStore, ThrottlerStorageRecord } from './throttler.types';

interface StoreEntry {
  count: number;
  resetTime: number;
}

@Injectable()
export class ThrottlerStorage implements ThrottlerStore {
  private current = new Map<string, StoreEntry>();
  private previous = new Map<string, StoreEntry>();
  private lastSwap = Date.now();
  private readonly swapIntervalMs = 60_000;

  increment(key: string, ttlMs: number): ThrottlerStorageRecord {
    // The window and limit arrive per call; a fixed-window counter needs only the window.
    this.maybeSwap();

    const now = Date.now();
    let entry = this.current.get(key) ?? this.previous.get(key);

    if (!entry || now >= entry.resetTime) {
      entry = { count: 0, resetTime: now + ttlMs };
    }

    entry.count++;
    this.current.set(key, entry);

    return {
      count: entry.count,
      ttlMs: entry.resetTime - now,
    };
  }

  reset(key: string): void {
    this.current.delete(key);
    this.previous.delete(key);
  }

  private maybeSwap(): void {
    const now = Date.now();
    if (now - this.lastSwap < this.swapIntervalMs) return;
    this.previous = this.current;
    this.current = new Map();
    this.lastSwap = now;
  }
}
