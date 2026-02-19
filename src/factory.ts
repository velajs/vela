import { EdgestApplication } from './application.js';
import { Container } from './container/container.js';
import type { Type } from './container/types.js';
import { RouteManager } from './http/route.manager.js';
import { ModuleLoader } from './module/module-loader.js';
import { ComponentManager } from './pipeline/component.manager.js';
import {
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
} from './pipeline/tokens.js';

export const EdgestFactory = {
  async create(rootModule: Type): Promise<EdgestApplication> {
    const container = new Container();
    const routeManager = new RouteManager(container);
    ComponentManager.init(container);

    const loader = new ModuleLoader(container, routeManager);
    loader.load(rootModule);

    // Resolve APP_* tokens registered via module providers
    if (container.has(APP_GUARD)) {
      routeManager.useGlobalGuards(container.resolve(APP_GUARD));
    }
    if (container.has(APP_PIPE)) {
      routeManager.useGlobalPipes(container.resolve(APP_PIPE));
    }
    if (container.has(APP_INTERCEPTOR)) {
      routeManager.useGlobalInterceptors(container.resolve(APP_INTERCEPTOR));
    }
    if (container.has(APP_FILTER)) {
      routeManager.useGlobalFilters(container.resolve(APP_FILTER));
    }
    if (container.has(APP_MIDDLEWARE)) {
      routeManager.useGlobalMiddleware(container.resolve(APP_MIDDLEWARE));
    }

    const app = new EdgestApplication(container, routeManager);
    const instances = loader.resolveAllInstances();
    app.setInstances(instances);

    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();

    // Build routes (async — supports CRUD integration with dynamic imports)
    await app.initRoutes();

    return app;
  },
};
