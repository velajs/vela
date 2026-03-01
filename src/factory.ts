import { VelaApplication } from './application';
import { Container } from './container/container';
import { ModuleRef } from './container/module-ref';
import type { Type } from './container/types';
import { RouteManager } from './http/route.manager';
import { ModuleLoader } from './module/module-loader';
import { ComponentManager } from './pipeline/component.manager';
import {
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
} from './pipeline/tokens';

export const VelaFactory = {
  async create(rootModule: Type): Promise<VelaApplication> {
    const container = new Container();
    container.register({ token: Container, useValue: container });
    container.register({ token: ModuleRef, useFactory: (c: Container) => new ModuleRef(c), inject: [Container] });
    const routeManager = new RouteManager(container);
    ComponentManager.init(container);

    const loader = new ModuleLoader(container, routeManager);
    loader.load(rootModule);

    const appGuards = loader.getAppProviderTokens(APP_GUARD);
    if (appGuards.length > 0) {
      routeManager.useGlobalGuardTokens(...appGuards);
    } else if (container.has(APP_GUARD)) {
      routeManager.useGlobalGuardTokens(APP_GUARD);
    }

    const appPipes = loader.getAppProviderTokens(APP_PIPE);
    if (appPipes.length > 0) {
      routeManager.useGlobalPipeTokens(...appPipes);
    } else if (container.has(APP_PIPE)) {
      routeManager.useGlobalPipeTokens(APP_PIPE);
    }

    const appInterceptors = loader.getAppProviderTokens(APP_INTERCEPTOR);
    if (appInterceptors.length > 0) {
      routeManager.useGlobalInterceptorTokens(...appInterceptors);
    } else if (container.has(APP_INTERCEPTOR)) {
      routeManager.useGlobalInterceptorTokens(APP_INTERCEPTOR);
    }

    const appFilters = loader.getAppProviderTokens(APP_FILTER);
    if (appFilters.length > 0) {
      routeManager.useGlobalFilterTokens(...appFilters);
    } else if (container.has(APP_FILTER)) {
      routeManager.useGlobalFilterTokens(APP_FILTER);
    }

    const appMiddleware = loader.getAppProviderTokens(APP_MIDDLEWARE);
    if (appMiddleware.length > 0) {
      routeManager.useGlobalMiddlewareTokens(...appMiddleware);
    } else if (container.has(APP_MIDDLEWARE)) {
      routeManager.useGlobalMiddlewareTokens(APP_MIDDLEWARE);
    }

    routeManager.registerConsumerMiddleware(loader.getConsumerMiddlewareDefinitions());

    const app = new VelaApplication(container, routeManager);
    const instances = await loader.resolveAllInstances();
    app.setInstances(instances);

    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();

    // Build routes (async — supports CRUD integration with dynamic imports)
    await app.initRoutes();

    return app;
  },
};
