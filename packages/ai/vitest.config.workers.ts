import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/__tests__/workers/**/*.test.ts'] },
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-09-25' } })],
});
