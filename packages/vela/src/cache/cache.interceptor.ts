import { Injectable } from '../container/decorators';
import { Reflector, SetMetadata } from '../pipeline/reflector';
import type { CallHandler, ExecutionContext, NestInterceptor } from '../pipeline/types';
import { sha256Base64Url } from '../crypto/hmac';
import { getRedirect, getResponseHeaders } from '../http/decorators';
import { executingRoute, markParsed, parseRouteResponse } from '../http/route-response';
import { getTrustedRequestIdentity } from '../http/trusted-request-identity';
import { CACHE_RESPONSE_METADATA } from './cache.tokens';
import { CacheService } from './cache.service';
import type { CacheResponseOptions, CacheScope } from './cache.types';
import { validateEntryOptions, validateLabel, validateScope } from './cache.validation';

/**
 * Cache a GET route's JSON result in `CacheModule`'s store, under the scope
 * its resolver selects after guards. Routes without it never cache.
 */
export function CacheResponse(options: CacheResponseOptions = {}) {
  validateEntryOptions(options);
  if (options.key !== undefined) validateLabel(options.key, 'Cache variant');
  return SetMetadata(
    CACHE_RESPONSE_METADATA,
    Object.freeze({ ...options, tags: options.tags && Object.freeze([...options.tags]) }),
  );
}

/** Serves `@CacheResponse()` routes; `CacheModule` registers it application-wide. */
@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const config = this.reflector.getAllAndOverride<CacheResponseOptions>(
      CACHE_RESPONSE_METADATA,
      context,
    );
    const request = context.getRequest();
    if (!config || request.method !== 'GET') return next.handle();
    const target = context.getClass();
    const handler = context.getHandlerName();
    const response = context.switchToHttp().getResponse();
    // The route's `response` schema parses the result here, so the cache holds
    // the value the route sends, never fields the schema strips, and
    // interceptors around the cache see that value whether or not it is served
    // from the cache.
    const handle = async () => parseRouteResponse(response, await next.handle());
    // The status of the route this request executes; outside the HTTP route
    // pipeline, nothing is cached.
    const status = executingRoute(response)?.status;
    const privateHeaders = getResponseHeaders(target, handler).some(
      ([name, value]) =>
        name.toLowerCase() === 'set-cookie' ||
        (name.toLowerCase() === 'cache-control' && /(?:^|,)\s*(?:private|no-store)\b/i.test(value)),
    );
    if (status !== 200 || getRedirect(target, handler) || privateHeaders) return handle();
    if (config.tags?.length && !this.cache.options.invalidation)
      throw new TypeError('Cache tags require an invalidation store.');
    let scope: CacheScope | undefined;
    try {
      scope = await this.cache.options.scope(context);
      if (scope === undefined) return handle();
      validateScope(scope);
    } catch (error) {
      this.cache.report('scope', error);
      return handle();
    }
    if (
      scope.visibility === 'public' &&
      (request.headers.has('authorization') ||
        request.headers.has('cookie') ||
        getTrustedRequestIdentity(request) !== undefined)
    )
      return handle();
    const unsafe = () =>
      response.res.headers.has('set-cookie') ||
      /(?:^|,)\s*(?:no-store|private)\b/i.test(response.res.headers.get('cache-control') ?? '') ||
      response.res.status !== 200;
    if (unsafe()) return handle();
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
        result = await handle();
        bypass = unsafe() || result instanceof Response;
        return bypass ? undefined : result;
      },
      config,
    );
    return bypass ? result : markParsed(response, value);
  }
}
