import { defineConfig } from 'vitest/config';

// Runs against the BUILT packages: the module contract is what consumers
// import, so `pnpm build` precedes `pnpm test:conformance`.
export default defineConfig({
  test: {
    globals: false,
    include: ['tests/modules/**/*.test.ts'],
  },
});
