import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const cloudflareWorkersShim = fileURLToPath(
  new URL('./test-shims/cloudflare-workers.ts', import.meta.url),
);
const cloudflareWorkflowsShim = fileURLToPath(
  new URL('./test-shims/cloudflare-workflows.ts', import.meta.url),
);
const cloudflareEmailShim = fileURLToPath(
  new URL('./test-shims/cloudflare-email.ts', import.meta.url),
);

export default defineConfig({
  oxc: false,
  // Dedupe @velajs/vela onto ONE physical copy across the whole module graph.
  // The Email Workers adapter passes a container built by THIS package's vela
  // into @velajs/mail's dispatcher, and @velajs/mail's `MailService` does
  // `@Inject(Container)` — the DI token IS vela's `Container` class, so mail and
  // cloudflare must share the same vela copy or the token mismatches. The linked
  // local @velajs/mail ships its own npm @velajs/vela; forcing resolution from
  // this package's node_modules (the local-repo link) reproduces what a real
  // install does on its own (both packages dedupe to one peer @velajs/vela) —
  // the same dev-link dedupe the pnpm-workspace hono override exists for.
  resolve: {
    dedupe: ['@velajs/vela'],
  },
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    // Real workerd tests import the `cloudflare:test` virtual module and run
    // through the dedicated workers-pool configuration.
    exclude: ['src/__tests__/workers/**', 'node_modules/**'],
    // The `cloudflare:workers` / `cloudflare:workflows` / `cloudflare:email`
    // runtime modules only exist in workerd; alias them to Node stubs so the DO
    // shell, the Workflow entrypoint, and the email transport can be unit-tested
    // outside Cloudflare.
    alias: [
      { find: /^cloudflare:workers$/, replacement: cloudflareWorkersShim },
      { find: /^cloudflare:workflows$/, replacement: cloudflareWorkflowsShim },
      { find: /^cloudflare:email$/, replacement: cloudflareEmailShim },
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
