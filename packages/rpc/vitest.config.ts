import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// The vela integration tests use parameter/class decorators (`@Injectable`,
// `@Inject`, `@Processor`, `@OnInboundEmail`), so tests are transpiled with SWC
// (legacy decorators + emitted metadata) rather than the default oxc transform.
export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['src/__tests__/workers/**', 'node_modules', 'dist'],
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
