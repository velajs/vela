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

/** The override of one named throttler; a route's value overrides its controller's. */
export const throttleMetadataKey = (name: string): string => `${THROTTLE_METADATA}:${name}`;
/** Whether one named throttler is skipped; a route's value overrides its controller's. */
export const skipThrottleMetadataKey = (name: string): string =>
  `${SKIP_THROTTLE_METADATA}:${name}`;
