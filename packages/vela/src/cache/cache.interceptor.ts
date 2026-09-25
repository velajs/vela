import { Injectable } from '../container/decorators';
import { Reflector, SetMetadata } from '../pipeline/reflector';
import type { CallHandler, ExecutionContext, NestInterceptor } from '../pipeline/types';
import { sha256Base64Url } from '../crypto/hmac';
import { getRedirect, getResponseHeaders } from '../http/decorators';
import { executingRoute, onResponseSent, replayResponse } from '../http/route-response';
import { getTrustedRequestIdentity } from '../http/trusted-request-identity';
import { CACHE_RESPONSE_METADATA } from './cache.tokens';
import { CacheService } from './cache.service';
import type { CacheResponseOptions, CacheScope } from './cache.types';
import { validateEntryOptions, validateLabel, validateScope } from './cache.validation';

/**
 * Cache the JSON or text response a GET route sends when the call
 * `CacheInterceptor` makes (the handler and the interceptors inside it)
 * succeeds — after interceptors and its `response` schema — in
 * `CacheModule`'s store, under the scope its resolver selects after guards; a
 * hit replays it without running the handler or parsing again. The entry
 * includes what every interceptor did for the request that stored it, those
 * outside `CacheInterceptor` included, so the scope must partition by
 * everything they vary the response on. Routes without it never cache.
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
    const c = context.switchToHttp().getResponse();
    // The status of the route this request executes; outside the HTTP route
    // pipeline, nothing is cached.
    const status = executingRoute(c)?.status;
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
    const unsafe = (response: Response) =>
      response.headers.has('set-cookie') ||
      /(?:^|,)\s*(?:no-store|private)\b/i.test(response.headers.get('cache-control') ?? '') ||
      response.status !== 200;
    if (unsafe(c.res)) return next.handle();
    const url = new URL(request.url);
    const query = new URLSearchParams(url.search);
    query.sort();
    // Hash length-framed components so variants/query text cannot escape the route namespace.
    const key = await sha256Base64Url(
      new TextEncoder().encode(
        JSON.stringify([url.origin, url.pathname, query.toString(), config.key ?? '']),
      ),
    );
    const lookup = await this.cache.lookupResponse(scope, key, config);
    if (lookup && 'hit' in lookup) {
      const { status: code, type, body } = lookup.hit;
      return replayResponse(
        c,
        new Response(body, { status: code, headers: { 'content-type': type } }),
      );
    }
    // Store the response the route sends, unless it turns out private or
    // answers for a handler call that failed or had not settled (a fallback an
    // interceptor outside the cache sent instead). A cache failure never fails
    // the response.
    let settled = false;
    if (lookup)
      onResponseSent(c, async (sent) => {
        const type = sent.headers.get('content-type');
        if (!settled || unsafe(c.res) || unsafe(sent) || type === null) return;
        let body: string;
        try {
          body = await sent.clone().text();
        } catch (error) {
          this.cache.report('write', error);
          return;
        }
        await lookup.store({ status: sent.status, type, body });
      });
    const value = await next.handle();
    settled = true;
    return value;
  }
}
