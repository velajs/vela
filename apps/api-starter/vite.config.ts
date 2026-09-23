import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';

// `vite dev` runs src/worker.ts in workerd and serves public/ as static assets;
// `vite build` writes the deployable Worker to dist/, which `wrangler deploy`
// then uploads. Better Auth trusts APP_ORIGIN, so the port never moves.
export default defineConfig({
  oxc,
  plugins: [cloudflare()],
  server: { port: 8790, strictPort: true },
  preview: { port: 8790, strictPort: true },
});
