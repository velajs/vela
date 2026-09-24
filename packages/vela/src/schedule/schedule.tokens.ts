import { InjectionToken } from '../container/index';
import type { ScheduleDispatchMode, ScheduleInvocationSeed } from './schedule.types';

export const CRON_METADATA = 'vela:cron';
export const INTERVAL_METADATA = 'vela:interval';

/**
 * Optional signed-dispatch policy for scheduled jobs. Provided (as a global
 * token, mirroring how `InternalDispatcher` is global) by
 * `ScheduleModule.forRoot({ dispatch })` and read by `invokeScheduledJob` on
 * every runtime. Absent ⇒ direct in-isolate invocation (default).
 */
export const SCHEDULE_DISPATCH = /* @__PURE__ */ new InjectionToken<ScheduleDispatchMode>(
  'vela:schedule:dispatch',
);

/**
 * Optional, runtime-neutral hook a runtime adapter provides so a scheduled job
 * fired outside its native trigger sees what the trigger would have seeded
 * into its scope. The Cloudflare adapter provides one that seeds a synthetic
 * `CLOUDFLARE_SCHEDULED_EVENT` for a cron job. Callers that fire jobs on
 * demand (Studio's run-now) pass it to `invokeScheduledJob` as `seed`:
 *
 * ```ts
 * const seed = container.has(SCHEDULE_INVOCATION_SEED)
 *   ? container.resolve(SCHEDULE_INVOCATION_SEED)
 *   : undefined;
 * await invokeScheduledJob(container, entry, invocation, {
 *   seed: seed && ((scope) => seed(scope, invocation)),
 * });
 * ```
 */
export const SCHEDULE_INVOCATION_SEED = /* @__PURE__ */ new InjectionToken<ScheduleInvocationSeed>(
  'vela:schedule:invocation-seed',
);
