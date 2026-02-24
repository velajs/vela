import { InjectionToken } from '../container/types';
import type { ScheduleModuleOptions } from './schedule.types';

export const SCHEDULE_MODULE_OPTIONS = new InjectionToken<ScheduleModuleOptions>('SCHEDULE_MODULE_OPTIONS');
export const CRON_METADATA = 'vela:cron';
export const INTERVAL_METADATA = 'vela:interval';
