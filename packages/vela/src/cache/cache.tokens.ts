import { InjectionToken } from '../container/types';
import type { CacheModuleOptions } from './cache.types';

export const CACHE_MODULE_OPTIONS = /* @__PURE__ */ new InjectionToken<CacheModuleOptions>(
  'CACHE_MODULE_OPTIONS',
);

export const CACHE_RESPONSE_METADATA = 'vela:response-cache';
