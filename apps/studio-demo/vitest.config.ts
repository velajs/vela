import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vela reads constructor dependencies from legacy decorators and the
  // `design:paramtypes` metadata they record; Vitest's Oxc transform emits both
  // only when asked.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    globals: false,
    include: ['__tests__/**/*.test.ts'],
    // The end-to-end walkthrough boots a real app + a real loopback host socket;
    // give it room and keep it serial (one host bind at a time).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
