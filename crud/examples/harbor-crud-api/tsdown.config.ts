import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  sourcemap: true,
});
