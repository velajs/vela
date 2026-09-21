import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/validation/index.ts',
    'src/internal.ts',
    'src/streaming/index.ts',
    'src/schedule-node/index.ts',
    'src/websocket/index.ts',
    'src/websocket-node/index.ts',
    'src/i18n/index.ts',
    'src/queue/index.ts',
    'src/live/index.ts',
    'src/storage/index.ts',
    'src/seeder/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
});
