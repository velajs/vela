import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    server: {
      deps: {
        // Load the workspace packages as Node does, so the tests and the
        // applications the CLI loads through its module runner share one
        // instance of each (their DI tokens are compared by identity).
        external: [/\/packages\/[^/]+\/dist\//],
      },
    },
  },
  plugins: [
    // Fixture apps in tests use vela's legacy decorators (+ design:paramtypes
    // metadata) — same SWC transform vela's own test suite uses.
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
