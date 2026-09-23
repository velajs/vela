import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// `vite dev` runs src/worker.ts in workerd; `vite build` writes the deployable
// Worker to dist/. Better Auth trusts this origin, so the port never moves.
export default defineConfig({
  // Vela reads constructor dependencies from legacy decorators and the
  // `design:paramtypes` metadata, which Oxc emits only when asked.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  plugins: [cloudflare()],
  server: { port: 8789, strictPort: true },
  preview: { port: 8789, strictPort: true },
});
