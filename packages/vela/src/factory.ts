import type { VelaApplication } from './application';
import type { Type } from './container/types';
import type { DynamicModule } from './registry/types';
import { applyRuntimeAdapters } from './factory/adapter';
import type { RuntimeAdapter } from './factory/adapter';
import { bootstrap } from './factory/bootstrap';
import { finalizeApplication } from './factory/finalize';
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
};
