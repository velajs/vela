import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/create-app.ts', 'src/walkthrough.ts', 'src/main.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
