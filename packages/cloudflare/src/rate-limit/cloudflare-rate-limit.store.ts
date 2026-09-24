import type { VelaEnv } from '@velajs/vela';
import type { EnvFactory } from '@velajs/vela/module-kit';
import type { ThrottlerStorageRecord, ThrottlerStore } from '@velajs/vela/throttler';
import { rateLimit } from '../bindings';

export interface RateLimitStoreOptions {
  /**
   * The Workers Rate Limiting binding (declared under `ratelimits`) that
   * serves every throttler, or one binding per named throttler:
   * `{ burst: 'BURST_LIMITER', sustained: 'API_LIMITER' }`. Each binding's
   * `simple.limit` and `simple.period` must equal its throttler's `limit` and
   * `ttl`; the platform enforces them. One binding therefore serves only
   * throttlers that share a limit and window: a throttler with other values
   * fails instead of being enforced at the binding's.
   */
  binding: string | Readonly<Record<string, string>>;
  /** Bound attacker-influenced tracking keys before calling the platform. Default 1024. */
  maxKeyBytes?: number;
}

/** The periods a Rate Limiting binding supports, in milliseconds. */
const PERIODS = new Set([10_000, 60_000]);

/**
 * `ThrottlerModule`'s storage over Workers Rate Limiting bindings, read from
 * each application's `ENV` by name:
 *
 * ```ts
 * ThrottlerModule.forRoot({
 *   throttlers: [{ ttl: 60_000, limit: 100 }],
 *   storage: rateLimitStore({ binding: 'API_LIMITER' }),
 * })
 * ```
 *
 * The platform makes the allow/deny decision and exposes no counters or reset
 * times, so the store reports no `remaining` quota. It enforces the limit and
 * period configured on the binding, so it declares `fixedLimits`: a
 * `@Throttle()` override that changes them fails instead of being ignored.
 * Periods are 10 or 60 seconds.
 */
export function rateLimitStore(options: RateLimitStoreOptions): EnvFactory<ThrottlerStore> {
  const maxKeyBytes = options.maxKeyBytes ?? 1_024;
  if (!Number.isSafeInteger(maxKeyBytes) || maxKeyBytes <= 0 || maxKeyBytes > 4_096) {
    throw new RangeError('maxKeyBytes must be between 1 and 4096');
  }
  const { binding } = options;
  const single = typeof binding === 'string' ? rateLimit({ binding }) : undefined;
  const named = new Map(
    typeof binding === 'string'
      ? []
      : Object.entries(binding).map(([name, ref]) => [name, rateLimit({ binding: ref })] as const),
  );
  if (single === undefined && named.size === 0) {
    throw new TypeError('rateLimitStore needs a binding, or one per named throttler');
  }
  const encoder = new TextEncoder();

  return (env: VelaEnv): ThrottlerStore => {
    // The first throttler the single binding served: the binding enforces one
    // limit and period, so it cannot also serve a throttler declaring others.
    let shared: { name: string; ttl: number; limit: number } | undefined;
    const assertShared = (name: string, ttl: number, limit: number): void => {
      shared ??= { name, ttl, limit };
      if (shared.ttl !== ttl || shared.limit !== limit) {
        throw new Error(
          `rateLimitStore({ binding: '${String(binding)}' }): one binding enforces one limit and ` +
            `period: throttlers '${shared.name}' (${shared.limit} per ${shared.ttl}ms) and ` +
            `'${name}' (${limit} per ${ttl}ms) need a binding each: ` +
            `rateLimitStore({ binding: { ${shared.name}: ..., ${name}: ... } }).`,
        );
      }
    };
    return {
      fixedLimits: true,

      async increment(
        key: string,
        ttl: number,
        limit: number,
        throttlerName: string,
      ): Promise<ThrottlerStorageRecord> {
        if (!PERIODS.has(ttl)) {
          throw new Error(
            `Throttler '${throttlerName}' has a ${ttl}ms window; Workers Rate Limiting bindings ` +
              'support periods of 10 or 60 seconds.',
          );
        }
        if (
          typeof key !== 'string' ||
          key.length === 0 ||
          /[\u0000-\u001f\u007f]/.test(key) ||
          encoder.encode(key).byteLength > maxKeyBytes
        ) {
          throw new Error('Refusing an invalid or oversized rate-limit key');
        }
        if (single !== undefined) assertShared(throttlerName, ttl, limit);
        const reference = single ?? named.get(throttlerName);
        if (reference === undefined) {
          throw new Error(
            `rateLimitStore has no rate limiting binding for throttler '${throttlerName}'. ` +
              'Map it in rateLimitStore({ binding: { name: BINDING } }).',
          );
        }
        const decision: unknown = await reference(env).limit({ key });
        const success: unknown =
          typeof decision === 'object' && decision !== null
            ? Reflect.get(decision, 'success')
            : undefined;
        if (typeof success !== 'boolean') {
          throw new Error('Cloudflare rate-limit binding returned an invalid decision');
        }
        return {
          // `allowed` is the authoritative platform decision; these sentinel counts
          // keep the record's shape without inventing a counter.
          count: success ? 0 : limit + 1,
          ttlMs: ttl,
          allowed: success,
        };
      },

      reset(): never {
        throw new Error('Cloudflare Rate Limiting bindings do not support counter reset');
      },
    };
  };
}
