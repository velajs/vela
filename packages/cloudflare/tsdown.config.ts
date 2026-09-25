import { defineConfig, type UserConfig } from 'tsdown';

const shared: UserConfig = {
  entry: [
    'src/index.ts',
    'src/durable-objects.ts',
    'src/queues.ts',
    'src/storage.ts',
    'src/testing.ts',
  ],
  format: ['esm'],
  platform: 'neutral',
  external: ['cloudflare:workers', 'cloudflare:test'],
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
    clean: false,
  },
]);
