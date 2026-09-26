import { defineConfig, type UserConfig } from 'tsdown';

const shared: UserConfig = {
  entry: [
    'src/index.ts',
    'src/durable-objects.ts',
    'src/email.ts',
    'src/entrypoints.ts',
    'src/pipelines.ts',
    'src/queue-events.ts',
    'src/queues.ts',
    'src/storage.ts',
    'src/tail.ts',
    'src/testing.ts',
    'src/tracing.ts',
    'src/workflows.ts',
    'src/workflow-definitions.ts',
  ],
  format: ['esm'],
  platform: 'neutral',
  external: ['cloudflare:workers', 'cloudflare:workflows', 'cloudflare:test'],
  target: 'es2024',
  fixedExtension: false,
};

export default defineConfig([
  {
    ...shared,
    dts: false,
    clean: true,
    sourcemap: true,
    // One module per source file: a shared chunk keeps every decorated class
    // it holds (`X = __decorate([...], X)` is a side effect), so a Worker that
    // only calls createCloudflareWorker() would ship storage, KV and the
    // signed-URL crypto its controller uses.
    unbundle: true,
    // An inlined constant leaves a bare `import './module.js'` behind, which
    // bundlers must warn about under `sideEffects: false`.
    inputOptions: { optimization: { inlineConst: false } },
  },
  {
    ...shared,
    dts: { emitDtsOnly: true },
    // Root-exported flag drivers retain the exact optional integration contract
    // without requiring that package merely to type-check a Cloudflare import.
    deps: { dts: { alwaysBundle: ['@velajs/feature-flags'] } },
    clean: false,
  },
]);
