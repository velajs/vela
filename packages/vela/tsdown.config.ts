import { defineConfig, type UserConfig } from 'tsdown';

const entry = [
  'src/index.ts',
  'src/validation/index.ts',
  'src/internal.ts',
  'src/streaming/index.ts',
  'src/observability/index.ts',
  'src/schedule-node/index.ts',
  'src/websocket/index.ts',
  'src/websocket-node/index.ts',
  'src/i18n/index.ts',
  'src/queue/index.ts',
  'src/live/index.ts',
  'src/storage/index.ts',
  'src/seeder/index.ts',
];

const shared: UserConfig = {
  entry,
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
};

export default defineConfig([
  {
    ...shared,
    dts: false,
    clean: true,
    sourcemap: true,
    unbundle: true,
  },
  {
    ...shared,
    dts: { emitDtsOnly: true },
    clean: false,
  },
]);
