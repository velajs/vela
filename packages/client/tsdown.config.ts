import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/presence.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
