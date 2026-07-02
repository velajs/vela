import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Workers-runtime smoke test for the OPT-IN ambient container. Runs under
// workerd with `nodejs_als` (see wrangler.als.toml) — the documented setup for
// `ambientContainer: true`.
export default defineConfig({
  test: {
    globals: false,
    include: ['src/__tests__/workers-als/**/*.test.ts'],
    setupFiles: ['./src/metadata.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.als.toml' },
    }),
  ],
});
