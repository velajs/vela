import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Package-local config: without one, vitest walks up to the workspace root
// config and would run zero of this example's tests.
export default defineConfig({
  test: { globals: false, include: ['src/**/*.test.ts'] },
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
  ],
});
