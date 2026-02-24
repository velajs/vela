import { Injectable, Inject } from '../container/decorators';
import { Reflector } from '../pipeline/reflector';
import type { CanActivate, ExecutionContext } from '../pipeline/types';
import { TooManyRequestsException } from '../errors/http-exception';
import { THROTTLER_OPTIONS, THROTTLER_STORAGE, THROTTLE_METADATA, SKIP_THROTTLE_METADATA } from './throttler.tokens';
import type { ThrottlerModuleOptions, ThrottlerStore, ThrottleConfig, RateLimitInfo } from './throttler.types';

@Injectable()
export class ThrottlerGuard implements CanActivate {
  private reflector = new Reflector();

  constructor(
    @Inject(THROTTLER_OPTIONS) private options: ThrottlerModuleOptions,
    @Inject(THROTTLER_STORAGE) private storage: ThrottlerStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_THROTTLE_METADATA, context);
    if (skip) {
      return true;
    }

    const override = this.reflector.getAllAndOverride<ThrottleConfig>(THROTTLE_METADATA, context);
    const limit = override?.limit ?? this.options.limit;
    const ttl = override?.ttl ?? this.options.ttl;

    const request = context.getRequest();
    const tracker = this.options.getTracker
      ? this.options.getTracker(request)
      : request.headers.get('x-forwarded-for') ?? 'anonymous';

    const className = context.getClass().name;
    const handlerName = String(context.getHandler());

    const key = this.options.generateKey
      ? this.options.generateKey(tracker, { className, handlerName })
      : `throttler:${className}:${handlerName}:${tracker}`;

    const { count, ttlMs } = await this.storage.increment(key, ttl);

    const remaining = Math.max(0, limit - count);
    const resetSeconds = Math.ceil(ttlMs / 1000);

    const honoContext = context.getContext();
    honoContext.header('X-RateLimit-Limit', String(limit));
    honoContext.header('X-RateLimit-Remaining', String(remaining));
    honoContext.header('X-RateLimit-Reset', String(resetSeconds));

    const rateLimitInfo: RateLimitInfo = { limit, remaining, reset: resetSeconds };
    honoContext.set('rateLimit', rateLimitInfo);

    if (count > limit) {
      honoContext.header('Retry-After', String(resetSeconds));
      throw new TooManyRequestsException();
    }

    return true;
  }
}
