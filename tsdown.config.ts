import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/config.ts', 'src/client-contract.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  sourcemap: true,
});
