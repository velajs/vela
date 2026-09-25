import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cloudflare/index.ts', 'src/harness.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  external: ['cloudflare:workers', 'cloudflare:workflows'],
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
