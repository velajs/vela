import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vela reads constructor dependencies from legacy decorators and the
  // `design:paramtypes` metadata they record; Vitest's Oxc transform emits both
  // only when asked.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    globals: false,
    include: ['test/**/*.test.ts'],
  },
});
