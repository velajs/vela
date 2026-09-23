import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The runnable example (apps/graphql-worker) declares its resolver with legacy
  // decorators; Oxc compiles them, and the constructor metadata, as its Vite build does.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    globals: false,
    include: ['src/__tests__/workers/**/*.test.ts', 'src/__tests__/security.test.ts'],
  },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.toml' } })],
});
