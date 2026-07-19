import { InjectionToken } from '../container/types';
import type { SecurityModuleOptions } from './security.types';

export const SECURITY_OPTIONS = new InjectionToken<SecurityModuleOptions>('SECURITY_OPTIONS');
