import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/vela/index.ts',
    'src/tenant/index.ts',
    'src/fields/index.ts',
    'src/files/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
