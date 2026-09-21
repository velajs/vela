import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/vela/index.ts',
    'src/plan.ts',
    'src/vocabulary.ts',
    'src/testing.ts',
    'src/cloudflare/index.ts',
    'src/d1/index.ts',
    'src/postgres/index.ts',
    'src/durable-objects/index.ts',
  ],
  external: [/\.wasm$/],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
