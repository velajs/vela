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
  throttleMetadataKey,
  skipThrottleMetadataKey,
} from './throttler.tokens';
import type {
  ThrottlerModuleOptions,
  ThrottlerOptions,
  ThrottlerStore,
  ThrottleConfig,
  RateLimitInfo,
} from './throttler.types';

const DEFAULT_THROTTLER = 'default';

/** A throttler as `ThrottlerModule.forRoot({ throttlers })` declares it, validated. */
export interface DeclaredThrottler {
  readonly name: string;
  readonly ttl: number;
  readonly limit: number;
}

/** The `@Throttle()` record of one route or controller. */
export type ThrottleRecord = Readonly<Record<string, ThrottleConfig>>;

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`ThrottlerModule: ${label} must be a positive integer.`);
  }
  return value;
}

/** Validate the declared throttlers, as the guard and the bootstrap check read them. */
export function declareThrottlers(
  throttlers: readonly ThrottlerOptions[] | undefined,
): DeclaredThrottler[] {
  if (!Array.isArray(throttlers) || throttlers.length === 0) {
    throw new TypeError(
      'ThrottlerModule needs at least one throttler: forRoot({ throttlers: [{ ttl, limit }] }).',
    );
  }
  const names = new Set<string>();
  return throttlers.map((throttler) => {
    const name = throttler.name ?? DEFAULT_THROTTLER;
    if (typeof name !== 'string' || name.length === 0 || /[^A-Za-z0-9_-]/.test(name)) {
      throw new TypeError(`ThrottlerModule: throttler name '${String(name)}' must be a word.`);
    }
    if (names.has(name)) {
      throw new TypeError(`ThrottlerModule: throttler '${name}' is declared twice.`);
    }
    names.add(name);
    return Object.freeze({
      name,
      ttl: positive(throttler.ttl, `throttler '${name}' ttl`),
      limit: positive(throttler.limit, `throttler '${name}' limit`),
    });
  });
}

function unknownThrottler(name: string, where: string): Error {
  return new Error(
    `@Throttle() on ${where} names throttler '${name}', which ` +
      'ThrottlerModule.forRoot({ throttlers }) does not declare.',
  );
}

function fixedLimitConflict(throttler: DeclaredThrottler, where: string): Error {
  return new Error(
    `The throttler storage enforces throttler '${throttler.name}' at its declared ` +
      `${throttler.limit} requests per ${throttler.ttl}ms; @Throttle() on ${where} cannot ` +
      'change them. Declare another named throttler with its own binding instead.',
  );
}

/**
 * Check one `@Throttle()` record against the declared throttlers: each name
 * must be declared, and a store with `fixedLimits` cannot take another value.
 */
export function checkThrottleRecord(
  record: ThrottleRecord | undefined,
  where: string,
  throttlers: readonly DeclaredThrottler[],
  fixedLimits: boolean | undefined,
): void {
  for (const [name, config] of Object.entries(record ?? {})) {
    const throttler = throttlers.find((declared) => declared.name === name);
    if (throttler === undefined) throw unknownThrottler(name, where);
    if (
      fixedLimits === true &&
      ((config.limit ?? throttler.limit) !== throttler.limit ||
        (config.ttl ?? throttler.ttl) !== throttler.ttl)
    ) {
      throw fixedLimitConflict(throttler, where);
    }
  }
}

/** A route handler's name, whether the context hands out the function or its name. */
function handlerNameOf(handler: unknown): string {
  return typeof handler === 'function' ? handler.name : String(handler);
}

const routeName = (context: ExecutionContext): string =>
  `${context.getClass().name}.${handlerNameOf(context.getHandler())}`;

@Injectable()
export class ThrottlerGuard implements CanActivate {
  readonly #throttlers: readonly DeclaredThrottler[];

  constructor(
    @Inject(THROTTLER_OPTIONS) private options: ThrottlerModuleOptions,
    @Inject(THROTTLER_STORAGE) private storage: ThrottlerStore,
    @Inject(RouteManager) private routeManager: RouteManager,
    private reflector: Reflector,
  ) {
    this.#throttlers = declareThrottlers(options.throttlers);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ThrottlerModule checks every discovered @Throttle() at bootstrap; this
    // covers routes it could not see, on the route and on its controller.
    for (const record of this.reflector.getAll<ThrottleRecord>(THROTTLE_METADATA, context)) {
      for (const name of Object.keys(record ?? {})) {
        if (!this.#throttlers.some((throttler) => throttler.name === name)) {
          throw unknownThrottler(name, routeName(context));
        }
      }
    }
    // Skipping a throttler this application does not declare is a no-op, as
    // in Nest: `@SkipThrottle()` names 'default' whatever the declarations.
    const active = this.#throttlers.filter(
      ({ name }) =>
        this.reflector.getAllAndOverride<boolean>(skipThrottleMetadataKey(name), context) !== true,
    );
    if (active.length === 0) return true;

    const tracker = this.tracker(context);
    const honoContext = context.getContext();
    const info: Record<string, RateLimitInfo> = {};
    for (const throttler of active) {
      // Each field falls back separately, route over controller, as in Nest v5.
      const limit =
        this.reflector.getAllAndOverride<number>(
          throttleMetadataKey(throttler.name, 'limit'),
          context,
        ) ?? throttler.limit;
      const ttl =
        this.reflector.getAllAndOverride<number>(
          throttleMetadataKey(throttler.name, 'ttl'),
          context,
        ) ?? throttler.ttl;
      if (this.storage.fixedLimits && (limit !== throttler.limit || ttl !== throttler.ttl)) {
        throw fixedLimitConflict(throttler, routeName(context));
      }

      const key = this.options.generateKey
        ? this.options.generateKey(context, tracker, throttler.name)
        : `throttler:${context.getClass().name}:${handlerNameOf(context.getHandler())}:` +
          `${throttler.name}:${tracker}`;
      // eslint-disable-next-line no-await-in-loop
      const record = await this.storage.increment(key, ttl, limit, throttler.name);
      const { count, ttlMs } = record;
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        !Number.isFinite(ttlMs) ||
        ttlMs <= 0 ||
        (record.allowed !== undefined && typeof record.allowed !== 'boolean') ||
        (record.remaining !== undefined &&
          (!Number.isSafeInteger(record.remaining) || record.remaining < 0))
      ) {
        throw new Error('[vela] throttler storage returned an invalid decision');
      }

      const remaining =
        record.remaining ?? (record.allowed === undefined ? Math.max(0, limit - count) : undefined);
      const resetSeconds = Math.ceil(ttlMs / 1000);
      const suffix = throttler.name === DEFAULT_THROTTLER ? '' : `-${throttler.name}`;
      honoContext.header(`X-RateLimit-Limit${suffix}`, String(limit));
      if (remaining !== undefined) {
        honoContext.header(`X-RateLimit-Remaining${suffix}`, String(remaining));
      }
      honoContext.header(`X-RateLimit-Reset${suffix}`, String(resetSeconds));
      info[throttler.name] = {
        limit,
        reset: resetSeconds,
        ...(remaining !== undefined ? { remaining } : {}),
      };
      honoContext.set('rateLimit', { ...info });

      if (record.allowed === false || count > limit) {
        honoContext.header(`Retry-After${suffix}`, String(resetSeconds));
        throw new TooManyRequestsException();
      }
    }
    return true;
  }

  private tracker(context: ExecutionContext): string {
    const request = context.getRequest();
    const trustedIdentity = getTrustedRequestIdentity(request);
    const rawTracker = trustedIdentity
      ? identityTracker(trustedIdentity)
      : this.options.getTracker
        ? this.options.getTracker(request, context)
        : (this.routeManager.resolveClientIp(context.getContext()) ?? 'anonymous');
    return typeof rawTracker === 'string' &&
      rawTracker.length > 0 &&
      rawTracker.length <= 1024 &&
      !/[\u0000-\u001f\u007f]/.test(rawTracker)
      ? rawTracker
      : 'anonymous';
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
