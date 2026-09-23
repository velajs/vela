import type { HttpMethod } from '../constants';
import type { NestMiddleware } from '../pipeline/types';
import type { Constructor, Type } from '../registry/types';

/** A Hono route pattern (`:param`, `*`), resolved under the global prefix. */
export interface RouteInfo {
  path: string;
  method?: HttpMethod;
  /**
   * Match `path` as written, without the global prefix. Use it for routes
   * served outside the prefix, such as RPC, WebSocket upgrade and OpenAPI
   * document routes, or routes added to the Hono app directly.
   */
  absolute?: boolean;
}

export interface MiddlewareRouteDefinition {
  /** Module that configured these middleware registrations. */
  readonly moduleId?: string;
  middleware: Array<Type<NestMiddleware> | NestMiddleware>;
  /** Patterns and controllers; a controller expands to its composed routes at route build. */
  routes: Array<RouteInfo | Constructor>;
  excludes: RouteInfo[];
  /** Stable-sort key; lower runs first. Default 0. */
  priority?: number;
}

export interface MiddlewareConfigProxy {
  /** Skip requests matching one of these patterns exactly. */
  exclude(...routes: Array<string | RouteInfo>): MiddlewareConfigProxy;
  withPriority(priority: number): MiddlewareConfigProxy;
  /**
   * Run whenever Hono dispatches a request to one of a controller's handlers,
   * or for a pattern and the paths beneath it. `'*'` matches every request.
   */
  forRoutes(...routes: Array<string | Constructor | RouteInfo>): MiddlewareConsumer;
}

export interface MiddlewareConsumer {
  apply(...middleware: Array<Type<NestMiddleware> | NestMiddleware>): MiddlewareConfigProxy;
}

export interface NestModule {
  configure(consumer: MiddlewareConsumer): void;
}

export class MiddlewareBuilder implements MiddlewareConsumer {
  private definitions: MiddlewareRouteDefinition[] = [];

  apply(...middleware: Array<Type<NestMiddleware> | NestMiddleware>): MiddlewareConfigProxy {
    const currentMiddleware = [...middleware];
    let currentExcludes: RouteInfo[] = [];
    let currentPriority: number | undefined;

    const proxy: MiddlewareConfigProxy = {
      exclude: (...routes: Array<string | RouteInfo>) => {
        currentExcludes = routes.map(normalizeRouteArg);
        return proxy;
      },
      withPriority: (priority: number) => {
        currentPriority = priority;
        return proxy;
      },
      forRoutes: (...routes: Array<string | Constructor | RouteInfo>) => {
        this.definitions.push({
          middleware: currentMiddleware,
          routes: routes.map((route) =>
            typeof route === 'function' ? route : normalizeRouteArg(route),
          ),
          excludes: [...currentExcludes],
          ...(currentPriority !== undefined ? { priority: currentPriority } : {}),
        });
        currentExcludes = [];
        currentPriority = undefined;
        return this;
      },
    };

    return proxy;
  }

  getDefinitions(): MiddlewareRouteDefinition[] {
    return [...this.definitions];
  }
}

function normalizeRouteArg(route: string | RouteInfo): RouteInfo {
  return typeof route === 'string' ? { path: route } : route;
}
