import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    // Workers smoke tests run under workerd via vitest.config.workers.ts —
    // exclude them from the Node-based run.
    exclude: ['src/__tests__/workers/**', 'src/__tests__/workers-als/**', 'node_modules/**'],
    setupFiles: ['./src/metadata.ts'],
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
