import type { Catalog } from '@velajs/errors';
import { InjectionToken } from '../container/types';
import type { ExceptionHandler } from '../exceptions/exception-handler';
import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from './types';

/**
 * Register global guards via module providers instead of app.useGlobalGuards().
 * The guard is constructed through DI in the declaring module.
 *
 * @example
 * ```ts
 * @Module({
 *   providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
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

/**
 * Register the application-wide exception handler via module providers.
 * Consumed by the shared error reporter (`resolveErrorReporter`) at every
 * transport edge to customize how errors are reported and rendered.
 *
 * @example
 * ```ts
 * @Module({
 *   providers: [
 *     { provide: APP_EXCEPTION_HANDLER, useValue: { report: (error) => tracker.capture(error) } },
 *   ],
 * })
 * class AppModule {}
 * ```
 */
export const APP_EXCEPTION_HANDLER = new InjectionToken<ExceptionHandler>('APP_EXCEPTION_HANDLER');

/**
 * Provide the composed error catalog (`composeCatalogs(CORE_CATALOG, …)`)
 * consulted when rendering wire-bound error bodies. Defaults to the core
 * catalog when unset.
 */
export const ERROR_CATALOG = new InjectionToken<Catalog<string>>('ERROR_CATALOG');
