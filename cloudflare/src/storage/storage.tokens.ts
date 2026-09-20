import { InjectionToken } from '@velajs/vela';
import type { StorageModuleOptions } from './storage.types';

export const STORAGE_OPTIONS = new InjectionToken<StorageModuleOptions>('STORAGE_OPTIONS');
