import { Injectable, Inject } from '../container/decorators';
import { Reflector } from '../pipeline/reflector';
import type { ExecutionContext, CallHandler, NestInterceptor } from '../pipeline/types';
import { CACHE_MANAGER, CACHE_MODULE_OPTIONS, CACHE_KEY_METADATA, CACHE_TTL_METADATA } from './cache.tokens';
import type { CacheModuleOptions, CacheStore } from './cache.types';

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  private reflector = new Reflector();

  constructor(
    @Inject(CACHE_MANAGER) private cacheStore: CacheStore,
    @Inject(CACHE_MODULE_OPTIONS) private options: CacheModuleOptions,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const request = context.getRequest();

    // Only cache GET requests
    if (request.method !== 'GET') {
      return next.handle();
    }

    // Determine cache key
    const customKey = this.reflector.getAllAndOverride<string>(CACHE_KEY_METADATA, context);
    const url = new URL(request.url);
    const cacheKey = customKey ?? `cache:GET:${url.pathname}`;

    // Check cache
    const cached = this.cacheStore.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Execute handler
    const result = await next.handle();

    // Determine TTL
    const customTtl = this.reflector.getAllAndOverride<number>(CACHE_TTL_METADATA, context);
    const ttl = customTtl ?? this.options.ttl ?? 5;

    // Store in cache
    this.cacheStore.set(cacheKey, result, ttl);

    return result;
  }
}
