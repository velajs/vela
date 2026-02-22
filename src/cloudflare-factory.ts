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
    const velaApp = await VelaFactory.create(rootModule);

    // One-time middleware: captures c.env on first request
    // and initializes all BindingRef instances from bindingsRegistry.
    // Registered via useGlobalMiddleware so it persists across rebuilds.
    let initialized = false;
    velaApp.useGlobalMiddleware({
      use: async (c: unknown, next: () => Promise<void>) => {
        if (!initialized) {
          initialized = true;
          const ctx = c as { env?: Record<string, unknown> };
          const env = ctx.env ?? {};
          for (const ref of bindingsRegistry) {
            ref._initialize(env[ref.bindingName]);
          }
        }
        await next();
      },
    });

    // Rebuild so the init middleware is placed before route handlers
    await velaApp.rebuild();

    const cfApp = new CloudflareApplication(velaApp);
    cfApp.scanInstances(velaApp.getInstances());
    return cfApp;
  },
};
