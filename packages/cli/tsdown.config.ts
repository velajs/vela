import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/config.ts', 'src/client-contract.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  // The CLI's Node stand-ins answer these at run time (see src/project/cloudflare-stubs.ts).
  external: [/^cloudflare:/],
  target: 'node24',
  fixedExtension: false,
  sourcemap: true,
});
