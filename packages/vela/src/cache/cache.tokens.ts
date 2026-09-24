import { InjectionToken } from '../container/types';
import type { CacheStore, CacheModuleOptions } from './cache.types';

export const CACHE_MANAGER = /* @__PURE__ */ new InjectionToken<CacheStore>('CACHE_MANAGER');
export const CACHE_MODULE_OPTIONS = /* @__PURE__ */ new InjectionToken<CacheModuleOptions>(
  'CACHE_MODULE_OPTIONS',
);

export const CACHEABLE_METADATA = 'vela:cacheable';
export const CACHE_KEY_METADATA = 'vela:cache-key';
export const CACHE_TTL_METADATA = 'vela:cache-ttl';

export const RESPONSE_CACHE_METADATA = 'vela:response-cache';
