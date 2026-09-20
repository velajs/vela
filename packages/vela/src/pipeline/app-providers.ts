import type { Container } from '../container/container';
import type { TypedToken } from '../container/types';
import type { RouteManager } from '../http/route.manager';
import type { ModuleLoader } from '../module/module-loader';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_MIDDLEWARE, APP_PIPE } from './tokens';

function bindSlot<T>(
  token: TypedToken<T>,
  bind: (...tokens: TypedToken<T>[]) => void,
  container: Container,
  loader: ModuleLoader,
): void {
  const collected = loader.getAppProviderTokens(token);
  if (collected.length > 0) bind(...collected);
  else if (container.has(token)) bind(token);
}

/**
 * Bind every APP_* provider registered in the container as a global
 * component on the RouteManager. The single source of truth for app-level
 * pipeline configuration — used by both VelaFactory.create and
 * @velajs/testing's TestingModuleBuilder.compile.
 */
export function bindAppProviders(
  routeManager: RouteManager,
  container: Container,
  loader: ModuleLoader,
): void {
  bindSlot(
    APP_GUARD,
    (...tokens) => routeManager.useGlobalGuardTokens(...tokens),
    container,
    loader,
  );
  bindSlot(APP_PIPE, (...tokens) => routeManager.useGlobalPipeTokens(...tokens), container, loader);
  bindSlot(
    APP_INTERCEPTOR,
    (...tokens) => routeManager.useGlobalInterceptorTokens(...tokens),
    container,
    loader,
  );
  bindSlot(
    APP_FILTER,
    (...tokens) => routeManager.useGlobalFilterTokens(...tokens),
    container,
    loader,
  );
  bindSlot(
    APP_MIDDLEWARE,
    (...tokens) => routeManager.useGlobalMiddlewareTokens(...tokens),
    container,
    loader,
  );
}
