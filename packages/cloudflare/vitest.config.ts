import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const cloudflareWorkersShim = fileURLToPath(
  new URL('./test-shims/cloudflare-workers.ts', import.meta.url),
);

export default defineConfig({
  oxc: false,
  // DI class tokens must have one identity throughout the module graph.
  resolve: {
    dedupe: ['@velajs/vela'],
  },
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    // Real workerd tests import the `cloudflare:test` virtual module and run
    // through the dedicated workers-pool configuration.
    exclude: ['src/__tests__/workers/**', 'node_modules/**'],
    // Native Durable Object classes require workerd; use a stub for unit tests.
    alias: [
      { find: /^cloudflare:workers$/, replacement: cloudflareWorkersShim },
      {
        find: /^cloudflare:workflows$/,
        replacement: fileURLToPath(
          new URL('./test-shims/cloudflare-workflows.ts', import.meta.url),
        ),
      },
    ],
  },
  plugins: [
    swc.vite({
      tsconfigFile: false,
      swcrc: false,
      jsc: {
        target: 'es2022',
        parser: {
          syntax: 'typescript',
          decorators: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        keepClassNames: true,
      },
    }),
  ],
});
