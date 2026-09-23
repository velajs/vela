// @velajs/vela/cache — the value cache (CacheModule) and the HTTP response
// cache (ResponseCacheModule).
import '../metadata';

export { CacheModule } from './cache.module';
export { CacheService } from './cache.service';
export { CacheInterceptor } from './cache.interceptor';
export { MemoryCacheStore } from './cache.store';
export { TieredCacheStore } from './tiered-cache.store';
export { Cacheable, CacheKey, CacheTTL } from './cache.decorators';
export {
  CACHE_MANAGER,
  CACHE_MODULE_OPTIONS,
  CACHEABLE_METADATA,
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
} from './cache.tokens';
export type {
  Awaitable,
  CacheModuleOptions,
  CacheStore,
  AsyncCacheStore,
  AnyCacheStore,
  CacheEntry,
  CacheEntryReader,
  CacheEntryWriter,
} from './cache.types';

export { ResponseCacheModule } from './response-cache.module';
export { ResponseCacheService, RESPONSE_CACHE_OPTIONS } from './response-cache.service';
export { ResponseCacheInterceptor, CacheResponse } from './response-cache.interceptor';
export { MemoryCacheInvalidationStore } from './cache-invalidation.store';
export type {
  ResponseCacheScope,
  CacheInvalidationStore,
  CacheInvalidationResult,
  ResponseCacheEntryOptions,
  CacheResponseOptions,
  ResponseCacheOptions,
  ScopedResponseCache,
} from './response-cache.types';
