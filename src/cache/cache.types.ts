export interface CacheModuleOptions {
  ttl?: number;       // default TTL in seconds (default: 5)
  max?: number;       // max entries (default: 100)
  isGlobal?: boolean; // register CacheInterceptor as APP_INTERCEPTOR
}

export interface CacheStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T, ttl?: number): void;
  del(key: string): void;
  clear(): void;
}

export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}
