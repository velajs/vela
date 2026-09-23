import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { oxc } from './oxc.config.ts';

// Runs test/ inside workerd with the bindings declared in wrangler.jsonc. The
// test pool takes the place of the Cloudflare Vite plugin, so it is not added here.
export default defineConfig({
  oxc,
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: 'vitest-only-secret-never-used-outside-tests-123456',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    })),
  ],
  test: { include: ['test/**/*.spec.ts'] },
});
