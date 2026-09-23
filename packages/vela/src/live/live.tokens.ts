import { InjectionToken } from '../container/types';
import type { CursorLog, LiveDriver, LiveModuleOptions } from './live.types';

// Free-form metadata keys — same string-token convention as the queue module.
export const LIVE_RESOLVER_METADATA = 'vela:live:resolver';

/** The invalidation driver in effect for a `LiveModule` instance (`localLive()` by default). */
export const LIVE_DRIVER = /* @__PURE__ */ new InjectionToken<LiveDriver>('vela:live:driver');

/** The ordered tag-invalidation log backing cursors/epochs for this log scope. */
export const LIVE_CURSOR_LOG = /* @__PURE__ */ new InjectionToken<CursorLog>(
  'vela:live:cursor-log',
);

// forRoot() options carrier.
export const LIVE_MODULE_OPTIONS = /* @__PURE__ */ new InjectionToken<LiveModuleOptions>(
  'LIVE_MODULE_OPTIONS',
);
