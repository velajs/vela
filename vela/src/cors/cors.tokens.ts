import { InjectionToken } from '../container/types';
import type { CorsOptions } from './cors.types';

export const CORS_OPTIONS = new InjectionToken<CorsOptions>('CORS_OPTIONS');
