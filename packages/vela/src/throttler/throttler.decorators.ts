import { SetMetadata } from '../pipeline/reflector';
import {
  THROTTLE_METADATA,
  SKIP_THROTTLE_METADATA,
  skipThrottleMetadataKey,
  throttleMetadataKey,
} from './throttler.tokens';
import type { ThrottleConfig } from './throttler.types';

/** Record the whole value and one entry per named throttler, as Nest keys them. */
function perThrottler<V>(
  recordKey: string,
  keyOf: (name: string) => string,
  record: Record<string, V>,
) {
  const entries = Object.entries(record);
  return (target: object, propertyKey?: string | symbol): void => {
    SetMetadata(recordKey, Object.freeze({ ...record }))(target, propertyKey);
    for (const [name, value] of entries) SetMetadata(keyOf(name), value)(target, propertyKey);
  };
}

/**
 * Override named throttlers on a route or controller, as Nest v5:
 * `@Throttle({ default: { limit: 3, ttl: 60_000 } })`. Each key names a
 * throttler declared by `ThrottlerModule.forRoot({ throttlers })`; a route's
 * override of a throttler replaces its controller's.
 */
export const Throttle = (overrides: Record<string, ThrottleConfig>) =>
  perThrottler(THROTTLE_METADATA, throttleMetadataKey, overrides);

/**
 * Skip named throttlers on a route or controller, as Nest v5:
 * `@SkipThrottle()` skips the `'default'` throttler, `@SkipThrottle({ short: true })`
 * the one named `short`, and `{ short: false }` on a route re-enables it under
 * a skipping controller.
 */
export const SkipThrottle = (skip: Record<string, boolean> = { default: true }) =>
  perThrottler(SKIP_THROTTLE_METADATA, skipThrottleMetadataKey, skip);
