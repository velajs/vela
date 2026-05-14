import { VelaApplication } from './application';
import type { Type } from './container/types';
import { bootstrap } from './factory/bootstrap';
import type { BootstrapOptions } from './factory/bootstrap';

export const VelaFactory = {
  async create(
    rootModule: Type,
    options: BootstrapOptions = {},
  ): Promise<VelaApplication> {
    const { container, routeManager, loader } = await bootstrap(rootModule, options);

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
