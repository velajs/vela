import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/auth/index.ts',
    'src/flags/index.ts',
    'src/queue/index.ts',
    'src/live/index.ts',
    'src/schedule/index.ts',
    'src/timetravel/index.ts',
    'src/crud/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
