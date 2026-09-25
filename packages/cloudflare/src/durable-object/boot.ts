import { VelaFactory, defineProvider } from '@velajs/vela';
import type { DynamicModule, Type, VelaApplicationContext, VelaEnv } from '@velajs/vela';
import type { Container, RuntimeAdapter } from '@velajs/vela/module-kit';
import { isCloudflareApp, type CloudflareApp } from '../cloudflare-factory';
import { registerCloudflarePlatform, type CloudflarePlatform } from '../platform';
import { withRootProviders, type CloudflareRoot } from '../root-module';
import { workerLivePlatform } from '../websocket/live-driver';
import { workerWebSocketTransport } from '../websocket/worker-transport';
import { internalEntrypointError } from '../rpc/entrypoint-error';
import { DO_ID, DO_STATE, DO_STORAGE } from './tokens';

/**
 * What a Durable Object class is built from: a static root module (a module
 * class or a `DynamicModule`), or an app from `defineCloudflareApp`, whose
 * root and runtime adapters the object shares with the Worker.
 */
export type DurableObjectRoot = CloudflareRoot | CloudflareApp;

/** @internal The root, adapters and app a Durable Object class is defined from. */
export interface DurableObjectDefinition {
  readonly rootModule: CloudflareRoot;
  readonly adapters: readonly RuntimeAdapter[];
  readonly app?: CloudflareApp;
}

/** @internal */
export function durableObjectDefinition(root: DurableObjectRoot): DurableObjectDefinition {
  if (isCloudflareApp(root)) {
    return { rootModule: root.rootModule, adapters: root.options.adapters ?? [], app: root };
  }
  return { rootModule: root, adapters: [] };
}

/** @internal Options of {@link createDurableObjectContext}. */
export interface DurableObjectContextOptions {
  readonly env: VelaEnv;
  /** Runtime adapters whose `configureContainer` runs in the object, after its platform. */
  readonly adapters?: readonly RuntimeAdapter[];
  /** This object's native state, injected as `DO_STATE`, `DO_STORAGE` and `DO_ID`. */
  readonly state?: DurableObjectState;
  /**
   * How the application reaches WebSocket rooms and live invalidation from
   * this object. Defaults to the Worker's: pushes and invalidations go to each
   * gateway room's Durable Object through its binding.
   */
  readonly platform?: (container: Container) => CloudflarePlatform;
}

/**
 * @internal The root a host Durable Object boots: `root` with `host` added to
 * its own providers, so the host injects what the root module can see.
 */
export function withDurableObjectHost(root: CloudflareRoot, host: Type): DynamicModule {
  return withRootProviders(root, [host]);
}

/**
 * @internal Boot the application context of one Durable Object instance with
 * the production bootstrap (`VelaFactory.createApplicationContext`): no HTTP
 * routes, its environment seeded as `ENV`, its platform and its native state
 * registered before any provider constructs, then the runtime adapters.
 */
export function createDurableObjectContext(
  root: CloudflareRoot,
  options: DurableObjectContextOptions,
): Promise<VelaApplicationContext> {
  const { env, state } = options;
  const platform =
    options.platform ??
    ((container: Container): CloudflarePlatform => ({
      websocket: workerWebSocketTransport(env),
      live: workerLivePlatform(env, container),
    }));
  return VelaFactory.createApplicationContext(root, {
    configureContainer: async (container) => {
      registerCloudflarePlatform(container, env, platform(container));
      if (state) {
        container.register(defineProvider(DO_STATE, { useValue: state }));
        container.register(defineProvider(DO_STORAGE, { useValue: state.storage }));
        container.register(defineProvider(DO_ID, { useValue: state.id }));
        container.markGlobalToken(DO_STATE);
        container.markGlobalToken(DO_STORAGE);
        container.markGlobalToken(DO_ID);
      }
      for (const adapter of options.adapters ?? []) {
        // Adapters configure the container in order, as for the Worker.
        // eslint-disable-next-line no-await-in-loop
        await adapter.configureContainer?.(container);
      }
    },
  });
}

/**
 * @internal Boot a Durable Object instance under `blockConcurrencyWhile`, so
 * no event runs before it is ready. A failure is logged, and resets the
 * object (the next event boots it again); workerd hands the callback's
 * rejection to every waiting caller, so they receive only a redacted
 * `EntrypointError`, never the startup error itself.
 */
export function startDurableObject<T>(
  state: Pick<DurableObjectState, 'blockConcurrencyWhile'>,
  name: string,
  boot: () => Promise<T>,
): Promise<T> {
  const ready = state.blockConcurrencyWhile(async () => {
    try {
      return await boot();
    } catch (error) {
      console.error(`[vela] Durable Object ${name} failed to start:`, error);
      throw internalEntrypointError();
    }
  });
  // Every handler awaits it; this observes a failure no handler has awaited yet.
  ready.catch(() => {});
  return ready;
}
