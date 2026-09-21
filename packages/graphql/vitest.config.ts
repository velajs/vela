import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  // graphql 16 publishes separate CJS/ESM constructor identities. Node-externalized
  // Yoga uses CJS; use that same entry for Vite-transformed test imports.
  resolve: {
    alias: [
      {
        find: /^graphql$/,
        replacement: fileURLToPath(new URL('./node_modules/graphql/index.js', import.meta.url)),
      },
    ],
  },
  test: { globals: false, include: ['src/**/*.test.ts'], exclude: ['src/__tests__/workers/**'] },
});
