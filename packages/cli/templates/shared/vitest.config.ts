import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { oxc } from './oxc.config.ts';

// Runs test/ inside workerd with the bindings declared in wrangler.jsonc. The
// test pool takes the place of the Cloudflare Vite plugin, so it is not added here.
export default defineConfig({
  oxc,
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: { include: ['test/**/*.spec.ts'] },
});
