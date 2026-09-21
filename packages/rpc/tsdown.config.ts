import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm'],
  dts: true,
  // Inline structural schema types so browser typechecking needs no Vela install.
  deps: { dts: { alwaysBundle: ['@velajs/vela/validation', '@standard-schema/spec'] } },
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
