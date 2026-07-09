import { defineConfig } from 'vitest/config';

// Without a package-local config, vitest walks up and finds the workspace
// root config (which only includes the root conformance tests/) — silently
// running ZERO of this package's tests. Keep this file even though the
// defaults would otherwise suffice.
export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
  },
});
