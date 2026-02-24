import { SetMetadata } from '../pipeline/reflector';
import { CACHE_KEY_METADATA, CACHE_TTL_METADATA } from './cache.tokens';

export const CacheKey = (key: string) => SetMetadata(CACHE_KEY_METADATA, key);
export const CacheTTL = (seconds: number) => SetMetadata(CACHE_TTL_METADATA, seconds);
