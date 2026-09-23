import { Injectable, Inject } from '../container/decorators';
import { Reflector } from '../pipeline/reflector';
import type { CanActivate, ExecutionContext } from '../pipeline/types';
import { TooManyRequestsException } from '../errors/http-exception';
import { RouteManager } from '../http/route.manager';
import {
  getTrustedRequestIdentity,
  type TrustedRequestIdentity,
} from '../http/trusted-request-identity';
import {
  THROTTLER_OPTIONS,
  THROTTLER_STORAGE,
  THROTTLE_METADATA,
  SKIP_THROTTLE_METADATA,
} from './throttler.tokens';
import type {
  ThrottlerModuleOptions,
  ThrottlerStore,
  ThrottleConfig,
  RateLimitInfo,
} from './throttler.types';

@Injectable()
export class ThrottlerGuard implements CanActivate {
  constructor(
    @Inject(THROTTLER_OPTIONS) private options: ThrottlerModuleOptions,
    @Inject(THROTTLER_STORAGE) private storage: ThrottlerStore,
    @Inject(RouteManager) private routeManager: RouteManager,
    private reflector: Reflector,
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
    const trustedIdentity = getTrustedRequestIdentity(request);
    const rawTracker = trustedIdentity
      ? identityTracker(trustedIdentity)
      : this.options.getTracker
        ? this.options.getTracker(request, context)
        : (this.routeManager.resolveClientIp(context.getContext()) ?? 'anonymous');
    const tracker =
      typeof rawTracker === 'string' &&
      rawTracker.length > 0 &&
      rawTracker.length <= 1024 &&
      !/[\u0000-\u001f\u007f]/.test(rawTracker)
        ? rawTracker
        : 'anonymous';

    const className = context.getClass().name;
    const handlerName = String(context.getHandler());

    const key = this.options.generateKey
      ? this.options.generateKey(tracker, { className, handlerName })
      : `throttler:${className}:${handlerName}:${tracker}`;

    const record = await this.storage.increment(key, ttl);
    const { count, ttlMs } = record;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      (record.allowed !== undefined && typeof record.allowed !== 'boolean') ||
      (record.remaining !== undefined &&
        (!Number.isSafeInteger(record.remaining) || record.remaining < 0)) ||
      (record.enforcedLimit !== undefined && record.enforcedLimit !== limit)
    ) {
      throw new Error('[vela] throttler storage returned an invalid or mismatched decision');
    }

    const remaining =
      record.remaining ?? (record.allowed === undefined ? Math.max(0, limit - count) : undefined);
    const resetSeconds = Math.ceil(ttlMs / 1000);

    const honoContext = context.getContext();
    honoContext.header('X-RateLimit-Limit', String(limit));
    if (remaining !== undefined) honoContext.header('X-RateLimit-Remaining', String(remaining));
    honoContext.header('X-RateLimit-Reset', String(resetSeconds));

    const rateLimitInfo: RateLimitInfo = {
      limit,
      reset: resetSeconds,
      ...(remaining !== undefined ? { remaining } : {}),
    };
    honoContext.set('rateLimit', rateLimitInfo);

    if (record.allowed === false || count > limit) {
      honoContext.header('Retry-After', String(resetSeconds));
      throw new TooManyRequestsException();
    }

    return true;
  }
}

function identityTracker(identity: TrustedRequestIdentity): string {
  const { issuer, subject, principalType } = identity.principal;
  // Explicit lengths prevent collisions when components contain separators.
  // Publication bounds all variable components, keeping this key below the
  // throttler's maximum without lossy truncation or fallback-bucket collapse.
  return `identity:${encodePart(identity.tenantId ?? '')}${encodePart(issuer)}${encodePart(subject)}${encodePart(principalType)}`;
}

const encodePart = (value: string): string => `${value.length}:${value}`;
