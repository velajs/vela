import { defineConfig, type UserConfig } from 'tsdown';

const entry = [
  'src/index.ts',
  'src/module-kit.ts',
  'src/internal.ts',
  'src/cache/index.ts',
  'src/contract/index.ts',
  'src/dispatch/index.ts',
  'src/event-emitter/index.ts',
  'src/health/index.ts',
  'src/fetch/index.ts',
  'src/i18n/index.ts',
  'src/live/index.ts',
  'src/logging/index.ts',
  'src/observability/index.ts',
  'src/openapi/index.ts',
  'src/queue/index.ts',
  'src/schedule/index.ts',
  'src/schedule-node/index.ts',
  'src/security/index.ts',
  'src/seeder/index.ts',
  'src/storage/index.ts',
  'src/streaming/index.ts',
  'src/throttler/index.ts',
  'src/validation/index.ts',
  'src/websocket/index.ts',
  'src/websocket-node/index.ts',
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
    treeshake: {
      // package.json#sideEffects names dist files, so the build would treat
      // src/metadata.ts as side-effect free and drop each entry's bare
      // `import './metadata'`. Keep it: it installs the Reflect polyfill.
      moduleSideEffects: (id) => (/[\\/]src[\\/]metadata\.ts$/u.test(id) ? true : undefined),
    },
  },
  {
    ...shared,
    dts: { emitDtsOnly: true },
    clean: false,
  },
]);
