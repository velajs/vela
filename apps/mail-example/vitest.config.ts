import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { oxc } from './oxc.config.ts';

export default defineConfig({
  oxc,
  test: { include: ['src/cloudflare/worker.test.ts'] },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
