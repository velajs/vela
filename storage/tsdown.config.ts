import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/client/index.ts',
    'src/drivers/memory/index.ts',
    'src/drivers/s3/index.ts',
    'src/drivers/r2/index.ts',
    'src/drivers/r2-http/index.ts',
    'src/middleware/index.ts',
    'src/storagesdk/index.ts',
    'src/testing/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
