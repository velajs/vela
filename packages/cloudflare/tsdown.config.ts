import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/durable-objects.ts', 'src/queues.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  external: ['cloudflare:workers'],
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
