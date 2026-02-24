import { InjectionToken } from '../container/types';
import type { CacheStore, CacheModuleOptions } from './cache.types';

export const CACHE_MANAGER = new InjectionToken<CacheStore>('CACHE_MANAGER');
export const CACHE_MODULE_OPTIONS = new InjectionToken<CacheModuleOptions>('CACHE_MODULE_OPTIONS');

export const CACHE_KEY_METADATA = 'vela:cache-key';
export const CACHE_TTL_METADATA = 'vela:cache-ttl';
