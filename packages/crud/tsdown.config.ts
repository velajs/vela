import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/adapter/index.ts',
    'src/model/index.ts',
    'src/query/index.ts',
    'src/csv/index.ts',
    'src/envelope/index.ts',
    'src/kernel/index.ts',
    'src/policies/index.ts',
    'src/multi-tenant/index.ts',
    'src/versioning/index.ts',
    'src/audit/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
