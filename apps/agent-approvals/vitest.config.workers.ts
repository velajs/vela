import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { oxc } from './oxc.config.ts';

export default defineConfig({
  oxc,
  test: { include: ['src/worker.test.ts'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        bindings: { DEMO_TOKEN: 'test-token', URL_SIGNING_SECRET: 'test-signing-secret' },
      },
    }),
  ],
});
