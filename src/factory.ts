import { VelaApplication } from './application';
import type { Type } from './container/types';
import { DiscoveryService } from './discovery/discovery.service';
import { INVOCATION_TRANSPORT } from './dispatch/tokens';
import type { InvocationTransport } from './dispatch/types';
import type { AdapterContext, RuntimeAdapter } from './factory/adapter';
import { bootstrap } from './factory/bootstrap';
import type { BootstrapOptions } from './factory/bootstrap';

export interface VelaCreateOptions extends BootstrapOptions {
  /**
   * Runtime adapters binding this app to a platform (Cloudflare bindings,
   * WebSocket transports, …). Their `requestMiddleware` is prepended to the
   * global middleware chain; `onBootstrap`/`onRoutesBuilt` hooks run around
   * route building. See {@link RuntimeAdapter}.
   */
  adapters?: RuntimeAdapter[];
}

export const VelaFactory = {
  async create(rootModule: Type, options: VelaCreateOptions = {}): Promise<VelaApplication> {
    const { adapters = [], ...bootstrapOptions } = options;

    const adapterMiddleware = adapters.flatMap((a) => a.requestMiddleware ?? []);
    if (adapterMiddleware.length > 0) {
      bootstrapOptions.middleware = [...adapterMiddleware, ...(bootstrapOptions.middleware ?? [])];
    }

    const { container, routeManager, loader } = await bootstrap(rootModule, bootstrapOptions);

    const app = new VelaApplication(container, routeManager);
    const instances = await loader.resolveAllInstances();
    app.setInstances(instances);

    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();

    const adapterContext: AdapterContext = {
      app,
      container,
      routeManager,
      discovery: container.resolve(DiscoveryService),
    };
    for (const adapter of adapters) {
      await adapter.onBootstrap?.(adapterContext);
    }

    // Build routes (async — supports route-contributor integration)
    await app.initRoutes();

    for (const adapter of adapters) {
      await adapter.onRoutesBuilt?.(adapterContext);
    }

    // Finalize the `ctx.run` transport now that the Hono app exists: the first
    // adapter that supplies one wins (cross-isolate re-entry), else the default
    // in-isolate short-circuit runs the full pipeline via app.fetch — so
    // @SignedInvocation() always verifies, network hop or not. Registered
    // late-and-global; InternalDispatcher resolves it lazily at run() time.
    const invocationTransport: InvocationTransport =
      adapters.reduce<InvocationTransport | undefined>(
        (found, a) => found ?? a.invocationTransport?.(adapterContext),
        undefined,
      ) ?? (async (request: Request) => app.fetch(request));
    container.register({ provide: INVOCATION_TRANSPORT, useValue: invocationTransport });
    container.markGlobalToken(INVOCATION_TRANSPORT);

    return app;
  },
};
