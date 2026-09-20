import { InjectionToken } from '../container/types';
import type { ThrottlerModuleOptions, ThrottlerStore } from './throttler.types';

export const THROTTLER_OPTIONS = new InjectionToken<ThrottlerModuleOptions>('THROTTLER_OPTIONS');
export const THROTTLER_STORAGE = new InjectionToken<ThrottlerStore>('THROTTLER_STORAGE');

export const THROTTLE_METADATA = 'vela:throttle';
export const SKIP_THROTTLE_METADATA = 'vela:skip-throttle';
