import { cloudflareTest } from '@cloudflare/vitest-plugin';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Real workerd Fetcher coverage for portable method RPC. */
export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/__tests__/workers/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({ wrangler: { configPath: './wrangler.test.toml' } }),
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
