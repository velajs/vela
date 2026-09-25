import { SetMetadata } from '../pipeline/reflector';
import {
  THROTTLE_METADATA,
  SKIP_THROTTLE_METADATA,
  skipThrottleMetadataKey,
  throttleMetadataKey,
} from './throttler.tokens';
import type { ThrottleConfig } from './throttler.types';

const FIELDS = ['limit', 'ttl'] as const;

/**
 * Override named throttlers on a route or controller, as Nest v5:
 * `@Throttle({ default: { limit: 3, ttl: 60_000 } })`. Each key names a
 * throttler declared by `ThrottlerModule.forRoot({ throttlers })`, which
 * checks the names at bootstrap. `limit` and `ttl` override separately: a
 * route's `limit` replaces its controller's and keeps the controller's `ttl`.
 * Both must be positive integers.
 */
export const Throttle = (overrides: Record<string, ThrottleConfig>) => {
  const entries = Object.entries(overrides);
  for (const [name, config] of entries) {
    for (const field of FIELDS) {
      const value = config[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError(
          `@Throttle(): throttler '${name}' ${field} must be a positive integer.`,
        );
      }
    }
  }
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor): void => {
    SetMetadata(THROTTLE_METADATA, Object.freeze({ ...overrides }))(
      target,
      propertyKey,
      descriptor,
    );
    for (const [name, config] of entries) {
      for (const field of FIELDS) {
        const value = config[field];
        if (value !== undefined) {
          SetMetadata(throttleMetadataKey(name, field), value)(target, propertyKey, descriptor);
        }
      }
    }
  };
};

/**
 * Skip named throttlers on a route or controller, as Nest v5:
 * `@SkipThrottle()` skips the `'default'` throttler, `@SkipThrottle({ short: true })`
 * the one named `short`, and `{ short: false }` on a route re-enables it under
 * a skipping controller.
 */
export const SkipThrottle = (skip: Record<string, boolean> = { default: true }) => {
  const entries = Object.entries(skip);
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor): void => {
    SetMetadata(SKIP_THROTTLE_METADATA, Object.freeze({ ...skip }))(
      target,
      propertyKey,
      descriptor,
    );
    for (const [name, value] of entries) {
      SetMetadata(skipThrottleMetadataKey(name), value)(target, propertyKey, descriptor);
    }
  };
};
