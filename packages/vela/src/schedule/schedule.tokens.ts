import { InjectionToken } from '../container/index';
import type { ScheduleDispatchMode } from './schedule.types';

export const CRON_METADATA = 'vela:cron';
export const INTERVAL_METADATA = 'vela:interval';

/**
 * Optional signed-dispatch policy for scheduled jobs. Provided (as a global
 * token, mirroring how `InternalDispatcher` is global) by
 * `ScheduleModule.forRoot({ dispatch })` and read `@Optional`ly by the
 * schedule-node executor. Absent ⇒ direct in-isolate invocation (default).
 */
export const SCHEDULE_DISPATCH = new InjectionToken<ScheduleDispatchMode>('vela:schedule:dispatch');
