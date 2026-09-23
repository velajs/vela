import { defineConfig } from 'tsdown';

// Compiles the Node smoke script (`pnpm smoke`) with Oxc. tsdown takes the legacy
// decorators and `design:paramtypes` metadata from tsconfig.json's
// experimentalDecorators and emitDecoratorMetadata; the lab's packages stay
// external and load from node_modules.
export default defineConfig({
  entry: ['src/smoke.ts'],
  platform: 'node',
  target: 'es2024',
  format: ['esm'],
  fixedExtension: false,
  dts: false,
});
