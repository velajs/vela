// @velajs/vela/cache — the one cache module: scoped values and @CacheResponse()
// routes over a memory, tiered or remote store.
import '../metadata';

export { CacheModule } from './cache.module';
export { CacheService } from './cache.service';
export { CacheInterceptor, CacheResponse } from './cache.interceptor';
export { CACHE_MODULE_OPTIONS } from './cache.tokens';
export { MemoryCacheStore } from './cache.store';
export { TieredCacheStore } from './tiered-cache.store';
export { MemoryCacheInvalidationStore } from './cache-invalidation.store';
export type {
  Awaitable,
  CacheEntry,
  CacheEntryOptions,
  CacheEntryReader,
  CacheEntryWriter,
  CacheInvalidationResult,
  CacheInvalidationStore,
  CacheModuleOptions,
  CacheResponseOptions,
  CacheScope,
  CacheStore,
  ResolvedCacheOptions,
  ScopedCache,
} from './cache.types';
