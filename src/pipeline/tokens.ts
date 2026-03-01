import { InjectionToken } from '../container/types';
import type { CanActivate, ExceptionFilter, NestInterceptor, NestMiddleware, PipeTransform } from './types';

/**
 * Register global guards via module providers instead of app.useGlobalGuards().
 *
 * @example
 * ```ts
 * @Module({
 *   providers: [
 *     AuthGuard,
 *     { provide: APP_GUARD, useClass: AuthGuard },
 *   ],
 * })
 * class AppModule {}
 * ```
 */
export const APP_GUARD = new InjectionToken<CanActivate>('APP_GUARD');

/**
 * Register global pipes via module providers.
 */
export const APP_PIPE = new InjectionToken<PipeTransform>('APP_PIPE');

/**
 * Register global interceptors via module providers.
 */
export const APP_INTERCEPTOR = new InjectionToken<NestInterceptor>('APP_INTERCEPTOR');

/**
 * Register global filters via module providers.
 */
export const APP_FILTER = new InjectionToken<ExceptionFilter>('APP_FILTER');

/**
 * Register global middleware via module providers.
 */
export const APP_MIDDLEWARE = new InjectionToken<NestMiddleware>('APP_MIDDLEWARE');
