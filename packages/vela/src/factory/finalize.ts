import { VelaApplication } from '../application';
import { VelaApplicationContext } from '../application-context';
import { defineProvider } from '../container/types';
import { DiscoveryService } from '../discovery/discovery.service';
import { INVOCATION_TRANSPORT } from '../dispatch/tokens';
import type { InvocationTransport } from '../dispatch/types';
import type { AdapterContext, RuntimeAdapter } from './adapter';
import type { BootstrapResult } from './bootstrap';

/**
 * Initialize a registered graph as an application context: construct its
 * providers and run `onModuleInit` and `onApplicationBootstrap`. A failure
 * disposes what was built and rethrows.
 */
export async function finalizeApplicationContext(
  { container, loader }: BootstrapResult,
  context: VelaApplicationContext = new VelaApplicationContext(container),
): Promise<VelaApplicationContext> {
  try {
    // Testing may replace dependency edges after bootstrap's initial scope pass.
    container.computeEffectiveScopes();
    context.setInstances(await loader.resolveAllInstances());
    await context.init();
    return context;
  } catch (error) {
    return disposeAfter(context, error);
  }
}

/** Finish a registered graph after all overrides, using the production lifecycle. */
export async function finalizeApplication(
  prepared: BootstrapResult,
  adapters: readonly RuntimeAdapter[] = [],
): Promise<VelaApplication> {
  const { container, routeManager } = prepared;
  const app = new VelaApplication(container, routeManager);
  await finalizeApplicationContext(prepared, app);
  try {
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
        ? await container.resolveAsync(INVOCATION_TRANSPORT)
        : async (request: Request) => app.fetch(request));
    container.register(defineProvider(INVOCATION_TRANSPORT, { useValue: transport }));
    container.markGlobalToken(INVOCATION_TRANSPORT);
    return app;
  } catch (error) {
    return disposeAfter(app, error);
  }
}

async function disposeAfter(context: VelaApplicationContext, error: unknown): Promise<never> {
  const failures: unknown[] = [error];
  try {
    await context.dispose();
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
