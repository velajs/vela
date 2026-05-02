import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Workers-runtime smoke tests for vela. Boots the framework inside
// workerd (via miniflare) and validates the edge-safe surface end-to-end
// — not just by static scan. See `src/__tests__/workers/basic.test.ts`.
//
// `cloudflareTest` is the integration plugin: it registers the cloudflare
// pool, configures the `cloudflare:test` virtual module, and wires Vite
// resolve conditions for the workerd target. The wrangler.toml at the
// repo root drives miniflare; its `main` entry boots a vela app.
export default defineConfig({
  test: {
    globals: false,
    include: ['src/__tests__/workers/**/*.test.ts'],
    setupFiles: ['./src/metadata.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
});
