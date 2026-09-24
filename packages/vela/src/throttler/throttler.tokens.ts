import { InjectionToken } from '../container/types';
import type { ThrottlerModuleOptions, ThrottlerStore } from './throttler.types';

export const THROTTLER_OPTIONS = /* @__PURE__ */ new InjectionToken<ThrottlerModuleOptions>(
  'THROTTLER_OPTIONS',
);
export const THROTTLER_STORAGE = /* @__PURE__ */ new InjectionToken<ThrottlerStore>(
  'THROTTLER_STORAGE',
);

/** The `@Throttle()` record of a route or controller. */
export const THROTTLE_METADATA = 'vela:throttle';
/** The `@SkipThrottle()` record of a route or controller. */
export const SKIP_THROTTLE_METADATA = 'vela:skip-throttle';

/**
 * One field of one named throttler's override, as Nest v5 keys them: a route's
 * `limit` overrides its controller's `limit`, and its `ttl` the controller's `ttl`.
 */
export const throttleMetadataKey = (name: string, field: 'limit' | 'ttl'): string =>
  `${THROTTLE_METADATA}:${name}:${field}`;
/** Whether one named throttler is skipped; a route's value overrides its controller's. */
export const skipThrottleMetadataKey = (name: string): string =>
  `${SKIP_THROTTLE_METADATA}:${name}`;
