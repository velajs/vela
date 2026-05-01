import { VelaApplication } from './application';
import { Container } from './container/container';
import { ModuleRef } from './container/module-ref';
import type { Type } from './container/types';
import { bindAppProviders } from './pipeline/app-providers';
import { RouteManager } from './http/route.manager';
import type { RouteManagerOptions } from './http/route.manager';
import { ModuleLoader } from './module/module-loader';
import type { NestMiddleware } from './pipeline/types';
import { ComponentManager } from './pipeline/component.manager';

export const VelaFactory = {
  async create(rootModule: Type, options: RouteManagerOptions = {}): Promise<VelaApplication> {
    const container = new Container();
    container.register({ provide: Container, useValue: container });
    container.register({ provide: ModuleRef, useFactory: (c: Container) => new ModuleRef(c), inject: [Container] });
    const routeManager = new RouteManager(container, options);
    ComponentManager.init(container);

    const loader = new ModuleLoader(container, routeManager);
    loader.load(rootModule);

    bindAppProviders(routeManager, container, loader);

    routeManager.registerConsumerMiddleware(loader.getConsumerMiddlewareDefinitions());

    if (options.globalPrefix) {
      routeManager.setGlobalPrefix(options.globalPrefix);
    }

    for (const handler of options.middleware ?? []) {
      const mw: NestMiddleware = { use: handler };
      routeManager.useGlobalMiddleware(mw);
    }

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

