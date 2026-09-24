import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';

// `vite dev` runs src/worker.ts in workerd; `vite build` writes the deployable
// Worker to dist/, which `wrangler deploy` then uploads.
export default defineConfig({
  oxc,
  plugins: [cloudflare()],
});
