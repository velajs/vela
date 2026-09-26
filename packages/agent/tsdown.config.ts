import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cloudflare/index.ts', 'src/mcp/index.ts', 'src/testing/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  external: ['cloudflare:workers', 'cloudflare:workflows'],
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
