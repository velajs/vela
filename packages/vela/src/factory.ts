import type { VelaApplication } from './application';
import type { Type } from './container/types';
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
  async create(rootModule: Type, options: VelaCreateOptions = {}): Promise<VelaApplication> {
    const { adapters = [], ...bootstrapOptions } = options;

    const adapterIpResolvers = adapters.filter(
      (adapter): adapter is RuntimeAdapter & Required<Pick<RuntimeAdapter, 'getClientIp'>> =>
        adapter.getClientIp !== undefined,
    );
    if (adapterIpResolvers.length > 1) {
      throw new Error(
        `Multiple runtime adapters provide getClientIp (${adapterIpResolvers.map((a) => a.name).join(', ')}); configure exactly one trust boundary`,
      );
    }
    if (bootstrapOptions.getClientIp && adapterIpResolvers.length === 1) {
      throw new Error(
        'Configure getClientIp either explicitly or through a runtime adapter, not both',
      );
    }
    if (adapterIpResolvers[0]) bootstrapOptions.getClientIp = adapterIpResolvers[0].getClientIp;

    const adapterMiddleware = adapters.flatMap((a) => a.requestMiddleware ?? []);
    if (adapterMiddleware.length > 0) {
      bootstrapOptions.middleware = [...adapterMiddleware, ...(bootstrapOptions.middleware ?? [])];
    }

    const configureContainer = bootstrapOptions.configureContainer;
    bootstrapOptions.configureContainer = async (container) => {
      for (const adapter of adapters) {
        await adapter.configureContainer?.(container);
      }
      await configureContainer?.(container);
    };

    return finalizeApplication(await bootstrap(rootModule, bootstrapOptions), adapters);
  },
};
