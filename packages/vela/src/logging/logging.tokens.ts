import { InjectionToken } from '../container/types';
import type { ApplicationLogger } from './application-logger';

// Kept apart from logging.module.ts: exception reporting checks for this token
// on every application, and importing it from the module file would ship
// LoggingModule, defineModule and the ApplicationLogger with every Worker.
export const APP_LOGGER = new InjectionToken<ApplicationLogger>('vela.applicationLogger');
