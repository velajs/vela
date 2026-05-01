import type { Container } from '../container/container';
import type { Token } from '../container/types';
import type { RouteManager } from '../http/route.manager';
import type { ModuleLoader } from '../module/module-loader';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from './tokens';

type Bind = (...tokens: Token[]) => RouteManager;

interface AppProviderSlot {
  token: Token;
  bind: (rm: RouteManager) => Bind;
}

// NestJS-style "APP_*" provider convention: each slot maps a well-known DI
// token to the RouteManager method that installs providers under it as a
// global component. Module-level @Provide(APP_*) entries expand into
// synthetic tokens (collected by ModuleLoader); a single @Inject(APP_*)
// provider falls back to the bare token.
const SLOTS: AppProviderSlot[] = [
  { token: APP_GUARD, bind: (rm) => rm.useGlobalGuardTokens.bind(rm) },
  { token: APP_PIPE, bind: (rm) => rm.useGlobalPipeTokens.bind(rm) },
  { token: APP_INTERCEPTOR, bind: (rm) => rm.useGlobalInterceptorTokens.bind(rm) },
  { token: APP_FILTER, bind: (rm) => rm.useGlobalFilterTokens.bind(rm) },
  { token: APP_MIDDLEWARE, bind: (rm) => rm.useGlobalMiddlewareTokens.bind(rm) },
];

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
  for (const { token, bind } of SLOTS) {
    const collected = loader.getAppProviderTokens(token);
    if (collected.length > 0) {
      bind(routeManager)(...collected);
    } else if (container.has(token)) {
      bind(routeManager)(token);
    }
  }
}
