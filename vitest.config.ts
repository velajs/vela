import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@velajs/vela': path.resolve(__dirname, '../vela/src/index.ts'),
    },
  },
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
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
