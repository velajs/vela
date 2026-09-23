import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// `vite dev` runs src/index.ts in workerd; `vite build` writes the deployable
// Worker to dist/, which `wrangler deploy` then uploads.
export default defineConfig({
  // Vela reads constructor dependencies from legacy decorators and the
  // `design:paramtypes` metadata they record, which Oxc emits only when asked.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  plugins: [cloudflare()],
  server: { port: 8787 },
});
