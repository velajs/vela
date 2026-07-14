import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const cloudflareWorkersShim = fileURLToPath(
  new URL('./test-shims/cloudflare-workers.ts', import.meta.url),
);
const cloudflareWorkflowsShim = fileURLToPath(
  new URL('./test-shims/cloudflare-workflows.ts', import.meta.url),
);

export default defineConfig({
  oxc: false,
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    // The `cloudflare:workers` / `cloudflare:workflows` runtime modules only
    // exist in workerd; alias them to Node stubs so the DO shell and the
    // Workflow entrypoint can be unit-tested outside Cloudflare.
    alias: [
      { find: /^cloudflare:workers$/, replacement: cloudflareWorkersShim },
      { find: /^cloudflare:workflows$/, replacement: cloudflareWorkflowsShim },
    ],
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
