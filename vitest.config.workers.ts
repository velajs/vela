import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Workers-runtime tests for the R2 native-binding driver. Boots workerd
// (via miniflare) with a real `[[r2_buckets]]` binding so the binding path
// is validated end-to-end — not just by static scan. See
// `src/__tests__/workers/r2-binding.test.ts`. The wrangler.toml drives
// miniflare; its `main` entry boots a vela app with the R2 driver.
export default defineConfig({
  test: {
    globals: false,
    include: ['src/__tests__/workers/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
});
