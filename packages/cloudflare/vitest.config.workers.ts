import { cloudflareTest } from '@cloudflare/vitest-plugin';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Real workerd/Miniflare coverage for the WebSocket + Durable Object path. */
export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/__tests__/workers/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.toml' },
      // Miniflare's local Pipelines binding is a no-op, not a remote stream.
      miniflare: { pipelines: ['PIPELINES_TEST_STREAM'] },
    }),
    swc.vite({
      tsconfigFile: false,
      swcrc: false,
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
});
