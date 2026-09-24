import { InjectionToken } from '../container/types';
import { RequestContextKey } from '../http/request-context';
import type { RateLimitInfo, ThrottlerModuleOptions, ThrottlerStore } from './throttler.types';

export const THROTTLER_OPTIONS = /* @__PURE__ */ new InjectionToken<ThrottlerModuleOptions>(
  'THROTTLER_OPTIONS',
);
export const THROTTLER_STORAGE = /* @__PURE__ */ new InjectionToken<ThrottlerStore>(
  'THROTTLER_STORAGE',
);

/** The throttling decision for the current request: `requestContext.get(RATE_LIMIT)`. */
export const RATE_LIMIT = /* @__PURE__ */ new RequestContextKey<RateLimitInfo>(
  'vela.throttler.rate-limit',
);

export const THROTTLE_METADATA = 'vela:throttle';
export const SKIP_THROTTLE_METADATA = 'vela:skip-throttle';
