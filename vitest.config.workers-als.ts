import swc from 'unplugin-swc';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Workers-runtime smoke test for the OPT-IN ambient container. Runs under
// workerd with `nodejs_als` (see wrangler.als.toml) — the documented setup for
// `ambientContainer: true`.
export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/__tests__/workers-als/**/*.test.ts'],
    setupFiles: ['./src/metadata.ts'],
  },
  plugins: [
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
    cloudflareTest({
      wrangler: { configPath: './wrangler.als.toml' },
    }),
  ],
});
