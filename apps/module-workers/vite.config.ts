import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';

// One Vite build for the four Workers. The public API is the entry Worker; the
// catalog, accounts and jobs Workers are auxiliary Workers with their own
// Wrangler files. `vite dev` runs all four in one workerd process with their
// service and queue bindings, and `vite build` writes each one, bundled on its
// own, to dist/<environment>/ (for example dist/module_jobs/).
export default defineConfig({
  oxc,
  plugins: [
    cloudflare({
      configPath: './wrangler.api.jsonc',
      auxiliaryWorkers: [
        { configPath: './wrangler.catalog.jsonc' },
        { configPath: './wrangler.accounts.jsonc' },
        { configPath: './wrangler.jobs.jsonc' },
      ],
    }),
  ],
  // The source maps list the modules in each bundle; the proof reads them to
  // check that the jobs Worker contains none of the HTTP feature modules.
  build: { sourcemap: true },
});
