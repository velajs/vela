import type { VelaApplication } from './application';
import type { VelaApplicationContext } from './application-context';
import type { Type } from './container/types';
import type { DynamicModule } from './registry/types';
import { applyRuntimeAdapters } from './factory/adapter';
import type { RuntimeAdapter } from './factory/adapter';
import { bootstrap } from './factory/bootstrap';
import { finalizeApplication, finalizeApplicationContext } from './factory/finalize';
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

/** Options of {@link VelaFactory.createApplicationContext}: the graph's environment and container. */
export type VelaApplicationContextOptions = Pick<
  BootstrapOptions,
  'diagnostics' | 'env' | 'configureContainer'
>;

export const VelaFactory = {
  /**
   * Create an application from a root module class or a `DynamicModule`
   * (`AppModule.forRoot(...)`). Configuration that depends on the runtime
   * environment belongs in providers that inject `ENV`, so one static root
   * serves every environment.
   */
  async create(
    rootModule: Type | DynamicModule,
    options: VelaCreateOptions = {},
  ): Promise<VelaApplication> {
    const { adapters = [], ...bootstrapOptions } = options;
    return finalizeApplication(
      await bootstrap(rootModule, applyRuntimeAdapters(bootstrapOptions, adapters)),
      adapters,
    );
  },

  /**
   * Create a standalone application context: the module graph with its
   * providers, lifecycle hooks and entrypoints, but no HTTP routes, as Nest's
   * `NestFactory.createApplicationContext`. Use it for scripts, custom
   * runtimes and platform objects (a Durable Object) that inject providers or
   * dispatch entrypoints without serving HTTP. It is initialized
   * (`onModuleInit`, `onApplicationBootstrap`) before it resolves;
   * `close()`/`dispose()` run the shutdown hooks.
   */
  async createApplicationContext(
    rootModule: Type | DynamicModule,
    options: VelaApplicationContextOptions = {},
  ): Promise<VelaApplicationContext> {
    return finalizeApplicationContext(await bootstrap(rootModule, options));
  },
};
