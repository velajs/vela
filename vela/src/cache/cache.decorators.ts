import { SetMetadata } from '../pipeline/reflector';
import { CACHEABLE_METADATA, CACHE_KEY_METADATA, CACHE_TTL_METADATA } from './cache.tokens';

/** Explicitly opts a route or controller into response caching. */
export const Cacheable = () => SetMetadata(CACHEABLE_METADATA, true);
export const CacheKey = (key: string) => SetMetadata(CACHE_KEY_METADATA, key);
export const CacheTTL = (seconds: number) => SetMetadata(CACHE_TTL_METADATA, seconds);
