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

    // Register the first-request middleware AFTER user-supplied middleware
    // (registered by bootstrap from `options.middleware`). Ordering matters:
    // runtime adapters like `@velajs/cloudflare` install binding-init
    // middleware that must run BEFORE OnFirstRequest hooks read those
    // bindings. Vela's middleware is appended last → fires after all user
    // middleware, before route handlers (which are registered separately).
    routeManager.useGlobalMiddleware({
      use: async (_c, next) => {
        await app.callOnFirstRequest();
        await next();
      },
    });

    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();

    // Build routes (async — supports CRUD integration with dynamic imports)
    await app.initRoutes();

    return app;
  },
};
