import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';

// The Cloudflare variant: `vite dev` runs src/worker.ts and its LiveRoom Durable
// Object in workerd and serves public/ (the bundled web client) as static
// assets; `vite build` writes the deployable Worker to dist/.
export default defineConfig({
  oxc,
  plugins: [cloudflare()],
  server: { port: 8789, strictPort: true },
  preview: { port: 8789, strictPort: true },
});
