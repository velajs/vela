import type { ThrottlerStorageRecord, ThrottlerStore } from '@velajs/vela';

/** The deliberately small surface exposed by a Workers Rate Limiting binding. */
export interface CloudflareRateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface CloudflareRateLimitStoreOptions {
  /** Must match the binding's configured `simple.limit`. */
  limit: number;
  /** Must match the binding's configured `simple.period`. */
  periodSeconds: 10 | 60;
  /** Bound attacker-influenced tracking keys before calling the platform. */
  maxKeyBytes?: number;
}

/**
 * Adapt a Cloudflare Workers Rate Limiting binding to Vela's throttler store.
 *
 * The platform binding makes the allow/deny decision. It does not expose exact
 * counters or reset timestamps, so this adapter intentionally omits `remaining`.
 */
export function cloudflareRateLimitStore(
  binding: CloudflareRateLimitBinding | (() => CloudflareRateLimitBinding),
  options: CloudflareRateLimitStoreOptions,
): ThrottlerStore {
  if (!binding || (typeof binding !== 'function' && typeof binding.limit !== 'function')) {
    throw new TypeError('A Cloudflare Rate Limiting binding is required');
  }
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit <= 0 ||
    options.limit >= Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError('Rate limit must be a positive safe integer');
  }
  if (options.periodSeconds !== 10 && options.periodSeconds !== 60) {
    throw new RangeError('Cloudflare rate-limit periods must be 10 or 60 seconds');
  }

  const maxKeyBytes = options.maxKeyBytes ?? 1_024;
  if (!Number.isSafeInteger(maxKeyBytes) || maxKeyBytes <= 0 || maxKeyBytes > 4_096) {
    throw new RangeError('maxKeyBytes must be between 1 and 4096');
  }

  const ttlMs = options.periodSeconds * 1_000;
  const encoder = new TextEncoder();
  const resolveBinding =
    typeof binding === 'function' ? binding : (): CloudflareRateLimitBinding => binding;

  return {
    async increment(key: string, requestedTtlMs: number): Promise<ThrottlerStorageRecord> {
      if (requestedTtlMs !== ttlMs) {
        throw new Error(
          `Cloudflare binding period mismatch: expected ${ttlMs}ms, received ${requestedTtlMs}ms`,
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

      const currentBinding = resolveBinding();
      if (!currentBinding || typeof currentBinding.limit !== 'function') {
        throw new Error('Cloudflare Rate Limiting binding is unavailable');
      }
      const decision = await currentBinding.limit({ key });
      if (!decision || typeof decision.success !== 'boolean') {
        throw new Error('Cloudflare rate-limit binding returned an invalid decision');
      }

      return {
        // Vela consumes `allowed` as the authoritative platform decision. These
        // sentinel counts preserve compatibility without inventing a counter.
        count: decision.success ? 0 : options.limit + 1,
        ttlMs,
        allowed: decision.success,
        enforcedLimit: options.limit,
      };
    },

    reset(): never {
      throw new Error('Cloudflare Rate Limiting bindings do not support counter reset');
    },
  };
}
