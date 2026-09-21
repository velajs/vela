import { VelaApplication } from '../application';
import { defineProvider } from '../container/types';
import { DiscoveryService } from '../discovery/discovery.service';
import { INVOCATION_TRANSPORT } from '../dispatch/tokens';
import type { InvocationTransport } from '../dispatch/types';
import type { AdapterContext, RuntimeAdapter } from './adapter';
import type { BootstrapResult } from './bootstrap';

/** Finish a registered graph after all overrides, using the production lifecycle. */
export async function finalizeApplication(
  { container, routeManager, loader }: BootstrapResult,
  adapters: readonly RuntimeAdapter[] = [],
): Promise<VelaApplication> {
  const app = new VelaApplication(container, routeManager);
  try {
    // Testing may replace dependency edges after bootstrap's initial scope pass.
    container.computeEffectiveScopes();
    app.setInstances(await loader.resolveAllInstances());
    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();

    const context: AdapterContext = {
      app,
      container,
      routeManager,
      discovery: container.resolve(DiscoveryService),
    };
    for (const adapter of adapters) await adapter.onBootstrap?.(context);
    await app.initRoutes();
    for (const adapter of adapters) await adapter.onRoutesBuilt?.(context);

    const transport: InvocationTransport =
      adapters.reduce<InvocationTransport | undefined>(
        (found, adapter) => found ?? adapter.invocationTransport?.(context),
        undefined,
      ) ??
      (container.has(INVOCATION_TRANSPORT)
        ? await container.resolveAsync<InvocationTransport>(INVOCATION_TRANSPORT)
        : async (request: Request) => app.fetch(request));
    container.register(defineProvider(INVOCATION_TRANSPORT, { useValue: transport }));
    container.markGlobalToken(INVOCATION_TRANSPORT);
    return app;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await app.dispose();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Application initialization and cleanup failed', {
        cause: error,
      });
    }
    throw error;
  }
}
