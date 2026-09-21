import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: false, include: ['src/__tests__/workers/**/*.test.ts'] },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.toml' } })],
});
