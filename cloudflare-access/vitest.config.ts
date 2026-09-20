import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// The `./vela` subpath ships decorator-based guards/module; tests exercise them
// through real `@Module`/`@Controller`/`@UseGuards` wiring, so the test runner
// must apply the legacy-decorator + metadata transform (matching the build's
// `experimentalDecorators`). swc handles it; vitest's built-in oxc pass is
// disabled so swc owns the transform.
export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
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
