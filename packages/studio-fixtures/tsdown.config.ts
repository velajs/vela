import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // Build-only tsconfig excluding __tests__, so the dts pass never emits stray
  // declaration files next to test sources. Typecheck still covers tests.
  tsconfig: './tsconfig.build.json',
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
