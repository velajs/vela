export interface ThrottleConfig {
  limit: number;
  ttl: number;
}

export interface ThrottlerStorageRecord {
  count: number;
  ttlMs: number;
}

export interface ThrottlerStore {
  increment(key: string, ttlMs: number): ThrottlerStorageRecord | Promise<ThrottlerStorageRecord>;
  reset(key: string): void | Promise<void>;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

export interface ThrottlerModuleOptions extends ThrottleConfig {
  storage?: ThrottlerStore;
  getTracker?: (request: Request) => string;
  generateKey?: (tracker: string, context: { className: string; handlerName: string }) => string;
}
