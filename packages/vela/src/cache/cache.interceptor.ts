import { Injectable } from '../container/decorators';
import { Reflector, SetMetadata } from '../pipeline/reflector';
import type { CallHandler, ExecutionContext, NestInterceptor } from '../pipeline/types';
import { sha256Base64Url } from '../crypto/hmac';
import { getRedirect, getResponseHeaders } from '../http/decorators';
import { DEFAULT_SUCCESS_STATUS, resolveSuccessStatus } from '../http/response-mapper';
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
    const status = resolveSuccessStatus(target, handler) ?? DEFAULT_SUCCESS_STATUS;
    const privateHeaders = getResponseHeaders(target, handler).some(
      ([name, value]) =>
        name.toLowerCase() === 'set-cookie' ||
        (name.toLowerCase() === 'cache-control' && /(?:^|,)\s*(?:private|no-store)\b/i.test(value)),
    );
    if (status !== 200 || getRedirect(target, handler) || privateHeaders) return next.handle();
    if (config.tags?.length && !this.cache.options.invalidation)
      throw new TypeError('Cache tags require an invalidation store.');
    let scope: CacheScope | undefined;
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
