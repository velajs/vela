import { Injectable, Inject } from '../container/decorators';
import { CACHE_MANAGER } from './cache.tokens';
import type { CacheStore } from './cache.types';

@Injectable()
export class CacheService {
  constructor(@Inject(CACHE_MANAGER) private store: CacheStore) {}

  get(key: string): unknown {
    return this.store.get(key);
  }

  /** Infer the domain type from a parser. Invalid stored values throw from the parser. */
  getParsed<T>(key: string, parse: (value: unknown) => T): T | undefined {
    const value = this.store.get(key);
    return value === undefined ? undefined : parse(value);
  }

  set(key: string, value: unknown, ttl?: number): void {
    this.store.set(key, value, ttl);
  }

  del(key: string): void {
    this.store.del(key);
  }

  clear(): void {
    this.store.clear();
  }
}
