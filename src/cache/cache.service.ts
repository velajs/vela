import { Injectable, Inject } from '../container/decorators';
import { CACHE_MANAGER } from './cache.tokens';
import type { CacheStore } from './cache.types';

@Injectable()
export class CacheService {
  constructor(@Inject(CACHE_MANAGER) private store: CacheStore) {}

  get<T = unknown>(key: string): T | undefined {
    return this.store.get<T>(key);
  }

  set<T = unknown>(key: string, value: T, ttl?: number): void {
    this.store.set(key, value, ttl);
  }

  del(key: string): void {
    this.store.del(key);
  }

  clear(): void {
    this.store.clear();
  }
}
