import { VelaFactory } from '@velajs/vela';
import type { Type } from '@velajs/vela';
import { CloudflareApplication } from './cloudflare-application';
import { bindingsRegistry } from './tokens';

/**
 * Factory for creating Cloudflare Worker applications.
 * Replaces `VelaFactory.create()` for Cloudflare apps.
 *
 * Sets up a one-time Hono middleware that captures `c.env` on the
 * first request and initializes all configured binding refs.
 *
 * @example
 * ```ts
 * const app = await CloudflareFactory.create(AppModule);
 * export default app; // has .fetch, .scheduled, .queue
 * ```
 */
export const CloudflareFactory = {
  async create(rootModule: Type): Promise<CloudflareApplication> {
    // One-time middleware: captures c.env on first request
    // and initializes all BindingRef instances from bindingsRegistry.
    let initialized = false;
    const velaApp = await VelaFactory.create(rootModule, {
      middleware: [
        async (c, next) => {
          if (!initialized) {
            initialized = true;
            const env = (c.env as Record<string, unknown>) ?? {};
            for (const ref of bindingsRegistry) {
              ref._initialize(env[ref.bindingName]);
            }
          }
          await next();
        },
      ],
    });

    const cfApp = new CloudflareApplication(velaApp);
    cfApp.scanInstances(velaApp.getInstances());
    return cfApp;
  },
};
