import { Injectable } from '../container/decorators';
import { Reflector, SetMetadata } from '../pipeline/reflector';
import type { CallHandler, ExecutionContext, NestInterceptor } from '../pipeline/types';
import { sha256Base64Url } from '../crypto/hmac';
import { getHttpCode, getRedirect, getResponseHeaders } from '../http/decorators';
import { getTrustedRequestIdentity } from '../http/trusted-request-identity';
import { getEndpointDefinition } from '../openapi/endpoint';
import { CACHEABLE_METADATA, RESPONSE_CACHE_METADATA } from './cache.tokens';
import { ResponseCacheService } from './response-cache.service';
import type { CacheResponseOptions, ResponseCacheScope } from './response-cache.types';
import { validateEntryOptions, validateLabel, validateScope } from './response-cache.validation';

/** Opt in to the asynchronous response-cache path, separately from legacy @Cacheable(). */
export function CacheResponse(options: CacheResponseOptions = {}) {
  validateEntryOptions(options);
  if (options.key !== undefined) validateLabel(options.key, 'Cache variant');
  return SetMetadata(
    RESPONSE_CACHE_METADATA,
    Object.freeze({ ...options, tags: options.tags && Object.freeze([...options.tags]) }),
  );
}

@Injectable()
export class ResponseCacheInterceptor implements NestInterceptor {
  private readonly reflector = new Reflector();
  constructor(private readonly cache: ResponseCacheService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const config = this.reflector.getAllAndOverride<CacheResponseOptions>(
      RESPONSE_CACHE_METADATA,
      context,
    );
    const request = context.getRequest();
    if (!config || request.method !== 'GET') return next.handle();
    const target = context.getClass();
    const handler = context.getHandler();
    const status =
      getEndpointDefinition(target, handler)?.status ?? getHttpCode(target, handler) ?? 200;
    const privateHeaders = getResponseHeaders(target, handler).some(
      ([name, value]) =>
        name.toLowerCase() === 'set-cookie' ||
        (name.toLowerCase() === 'cache-control' && /(?:^|,)\s*(?:private|no-store)\b/i.test(value)),
    );
    if (status !== 200 || getRedirect(target, handler) || privateHeaders) return next.handle();
    if (this.reflector.getAllAndOverride<boolean>(CACHEABLE_METADATA, context))
      throw new TypeError('Use only @CacheResponse on async response-cache routes.');
    if (config.tags?.length && !this.cache.options.invalidation)
      throw new TypeError('Cache tags require an invalidation store.');
    let scope: ResponseCacheScope | undefined;
    try {
      scope = await this.cache.options.scope(context);
      if (scope === undefined) return next.handle();
      validateScope(scope);
    } catch (error) {
      this.cache.report('scope', error);
      return next.handle();
    }
    if (
      scope.visibility === 'public' &&
      (request.headers.has('authorization') ||
        request.headers.has('cookie') ||
        getTrustedRequestIdentity(request) !== undefined)
    )
      return next.handle();
    const response = context.switchToHttp().getResponse();
    const unsafe = () =>
      response.res.headers.has('set-cookie') ||
      /(?:^|,)\s*(?:no-store|private)\b/i.test(response.res.headers.get('cache-control') ?? '') ||
      response.res.status !== 200;
    if (unsafe()) return next.handle();
    const url = new URL(request.url);
    const query = new URLSearchParams(url.search);
    query.sort();
    // Hash length-framed components so variants/query text cannot escape the route namespace.
    const key = await sha256Base64Url(
      new TextEncoder().encode(
        JSON.stringify([url.origin, url.pathname, query.toString(), config.key ?? '']),
      ),
    );
    const scoped = this.cache.scoped(scope, 'http');
    let result: unknown;
    let bypass = false;
    const value = await scoped.remember(
      key,
      async () => {
        result = await next.handle();
        bypass = unsafe() || result instanceof Response;
        return bypass ? undefined : result;
      },
      config,
    );
    return bypass ? result : value;
  }
}
