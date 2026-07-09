import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Absolute path relative to this config file. */
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Run the ported conformance suite directly against the ENGINE SOURCE (not
  // the built dist), mirroring how @velajs/crud's own subpath exports resolve.
  // Order matters: longest keys first so `@velajs/crud/adapter` matches before
  // the bare `@velajs/crud` (first alias entry wins in @rollup/plugin-alias).
  resolve: {
    alias: [
      { find: '@velajs/crud/adapter', replacement: r('./packages/core/src/adapter/index.ts') },
      { find: '@velajs/crud/model', replacement: r('./packages/core/src/model/index.ts') },
      { find: '@velajs/crud/query', replacement: r('./packages/core/src/query/index.ts') },
      { find: '@velajs/crud/envelope', replacement: r('./packages/core/src/envelope/index.ts') },
      { find: '@velajs/crud/policies', replacement: r('./packages/core/src/policies/index.ts') },
      { find: '@velajs/crud/kernel', replacement: r('./packages/core/src/kernel/index.ts') },
      { find: '@velajs/crud/multi-tenant', replacement: r('./packages/core/src/multi-tenant/index.ts') },
      { find: '@velajs/crud/versioning', replacement: r('./packages/core/src/versioning/index.ts') },
      { find: '@velajs/crud/audit', replacement: r('./packages/core/src/audit/index.ts') },
      { find: '@velajs/crud', replacement: r('./packages/core/src/index.ts') },
      { find: '@velajs/crud-memory', replacement: r('./packages/memory/src/index.ts') },
    ],
  },
  test: {
    globals: false,
    include: ['tests/**/*.test.ts'],
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
