import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { oxc } from './oxc.config.ts';

// Runs test/ inside workerd with both D1 databases declared in wrangler.jsonc.
// The test pool takes the place of the Cloudflare Vite plugin.
export default defineConfig({
  oxc,
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          PRIMARY_MIGRATIONS: await readD1Migrations('./migrations/primary'),
          ANALYTICS_MIGRATIONS: await readD1Migrations('./migrations/analytics'),
        },
      },
    })),
  ],
  test: { include: ['test/**/*.spec.ts'] },
});
