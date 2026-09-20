import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/app.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
