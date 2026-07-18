import { Injectable, Inject } from '../container/decorators';
import { Reflector } from '../pipeline/reflector';
import type { ExecutionContext, CallHandler, NestInterceptor } from '../pipeline/types';
import { sha256Base64Url } from '../crypto/hmac';
import {
  CACHE_MANAGER,
  CACHE_MODULE_OPTIONS,
  CACHEABLE_METADATA,
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
} from './cache.tokens';
import type { CacheModuleOptions, CacheStore } from './cache.types';

const MAX_CACHE_VARIATION_BYTES = 2048;

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  private reflector = new Reflector();

  constructor(
    @Inject(CACHE_MANAGER) private cacheStore: CacheStore,
    @Inject(CACHE_MODULE_OPTIONS) private options: CacheModuleOptions,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const request = context.getRequest();

    // A globally registered cache interceptor must remain inert unless the
    // route/controller explicitly opts in. Accidental shared caching is a data
    // disclosure boundary, so @Cacheable() is required even for GET routes.
    const cacheable = this.reflector.getAllAndOverride<boolean>(CACHEABLE_METADATA, context);
    if (cacheable !== true || request.method !== 'GET') {
      return next.handle();
    }

    const credentialed = Boolean(
      request.headers.get('authorization') || request.headers.get('cookie'),
    );
    let variationDigest: string | undefined;

    if (this.options.varyBy) {
      try {
        const variation = await this.options.varyBy(request);
        if (variation === undefined) {
          if (credentialed) return next.handle();
        } else {
          const bytes = new TextEncoder().encode(variation);
          if (variation.length === 0 || bytes.byteLength > MAX_CACHE_VARIATION_BYTES) {
            return next.handle();
          }
          variationDigest = await sha256Base64Url(bytes);
        }
      } catch {
        // A variation failure can never fall back to a shared credentialed
        // entry. Bypass on every callback error, including anonymous requests.
        return next.handle();
      }
    } else if (credentialed) {
      // Never include bearer tokens or cookies themselves in cache keys. An
      // authenticated response is cacheable only with an explicit stable
      // principal/tenant partition supplied by varyBy.
      return next.handle();
    }

    // Determine cache key
    const customKey = this.reflector.getAllAndOverride<string>(CACHE_KEY_METADATA, context);
    const url = new URL(request.url);
    const query = new URLSearchParams(url.search);
    query.sort();
    const scopedPath = `${url.host}${url.pathname}${query.size > 0 ? `?${query}` : ''}`;
    // Custom keys are a suffix, never a replacement for host/path/query.
    // Otherwise two routes using the same decorator value could disclose one
    // route's cached representation through another.
    const baseKey = customKey
      ? `cache:GET:${scopedPath}:key:${customKey}`
      : `cache:GET:${scopedPath}`;
    const cacheKey = variationDigest ? `${baseKey}:vary:${variationDigest}` : baseKey;

    // Check cache
    const cached = this.cacheStore.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Execute handler
    const result = await next.handle();

    // A Response may be streamed/one-shot or carry Set-Cookie/private headers;
    // caching the pre-mapped object is unsafe and cannot be replayed reliably.
    if (result instanceof Response) return result;

    // Hono lets a handler stage headers on its Context while returning a plain
    // object. That object must not enter a shared cache when the staged response
    // creates/rotates a session cookie.
    const response = context.switchToHttp().getResponse<{ res?: Response }>().res;
    if (response?.headers.has('set-cookie')) return result;

    // Determine TTL
    const customTtl = this.reflector.getAllAndOverride<number>(CACHE_TTL_METADATA, context);
    const ttl = customTtl ?? this.options.ttl ?? 5;

    // Store in cache
    this.cacheStore.set(cacheKey, result, ttl);

    return result;
  }
}
