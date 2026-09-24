import { InjectionToken } from '../container/types';
import type { CursorLog, LiveDriver, LiveModuleOptions, LivePlatform } from './live.types';

// Free-form metadata keys — same string-token convention as the queue module.
export const LIVE_RESOLVER_METADATA = 'vela:live:resolver';

/** The invalidation driver in effect for a `LiveModule` instance (`localLive()` by default). */
export const LIVE_DRIVER = /* @__PURE__ */ new InjectionToken<LiveDriver>('vela:live:driver');

/** The ordered tag-invalidation log backing cursors/epochs for this log scope. */
export const LIVE_CURSOR_LOG = /* @__PURE__ */ new InjectionToken<CursorLog>(
  'vela:live:cursor-log',
);

/**
 * The platform's live wiring (global, optional): default driver and cursor
 * log, and driver binding. A runtime adapter registers it before modules
 * load; `LiveModule` reads it.
 */
export const LIVE_PLATFORM = /* @__PURE__ */ new InjectionToken<LivePlatform>('vela:live:platform');

// forRoot() options carrier.
export const LIVE_MODULE_OPTIONS = /* @__PURE__ */ new InjectionToken<LiveModuleOptions>(
  'LIVE_MODULE_OPTIONS',
);
