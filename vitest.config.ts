import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const cloudflareWorkersShim = fileURLToPath(
  new URL('./test-shims/cloudflare-workers.ts', import.meta.url),
);

export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    // The `cloudflare:workers` runtime module only exists in workerd; alias it
    // to a Node stub so the DO shell can be unit-tested outside Cloudflare.
    alias: [{ find: /^cloudflare:workers$/, replacement: cloudflareWorkersShim }],
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
