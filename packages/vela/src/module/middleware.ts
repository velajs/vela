import { HttpMethod } from '../constants';
import type { NestMiddleware } from '../pipeline/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, Type } from '../registry/types';

export interface RouteInfo {
  path: string;
  method?: HttpMethod;
}

export interface MiddlewareRouteDefinition {
  middleware: Array<Type<NestMiddleware> | NestMiddleware>;
  routes: RouteInfo[];
  excludes: RouteInfo[];
  /** Stable-sort key; lower runs first. Default 0. */
  priority?: number;
}

export interface MiddlewareConfigProxy {
  exclude(...routes: Array<string | RouteInfo>): MiddlewareConfigProxy;
  withPriority(priority: number): MiddlewareConfigProxy;
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
          routes: routes.flatMap(resolveRouteArg),
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

function resolveRouteArg(route: string | Constructor | RouteInfo): RouteInfo[] {
  if (typeof route === 'string') {
    return [{ path: route }];
  }
  if (typeof route === 'function') {
    const prefix = MetadataRegistry.getControllerPath(route as Constructor);
    return [{ path: prefix || '/' }];
  }
  return [route];
}
