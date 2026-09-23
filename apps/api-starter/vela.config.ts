import { defineVelaConfig } from '@velajs/cli/config';
import { cloudflareAdapter } from '@velajs/cloudflare';
import { VelaFactory } from '@velajs/vela';
import { getPlatformProxy } from 'wrangler';
import { AppModule } from './src/app';

/**
 * `pnpm client:generate` runs `vela client generate`, which loads this file and
 * `src/` through Vite with the Worker build's Oxc options, documents the static
 * `AppModule`, and builds the application once to check that the document
 * covers its routes. The module factories read `ENV` while the application is
 * built, so it gets the local bindings Wrangler provides for Node tooling:
 * `wrangler.jsonc` vars, `.dev.vars` secrets when present and an in-memory D1
 * database. Nothing is queried, and `LIVE_ROOM` is never called, which is why
 * Wrangler's warning about the internal Durable Object is harmless here.
 */
export default defineVelaConfig({
  rootModule: AppModule,
  async createApp() {
    const platform = await getPlatformProxy<Cloudflare.Env>({ persist: false });
    try {
      const app = await VelaFactory.create(AppModule, {
        adapters: [cloudflareAdapter({ env: platform.env })],
      });
      // The CLI disposes the application; the local runtime closes after it.
      const dispose = app.dispose.bind(app);
      app.dispose = (signal) => dispose(signal).finally(() => platform.dispose());
      return app;
    } catch (error) {
      await platform.dispose();
      throw error;
    }
  },
});
