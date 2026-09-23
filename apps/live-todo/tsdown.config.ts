import { defineConfig } from 'tsdown';

// The Node host (`pnpm start`): src/server-node.ts with the @hono/node-ws
// transport. Workers never load it; vite.config.ts builds the Worker. tsdown
// compiles with Oxc too and takes the legacy decorators and `design:paramtypes`
// metadata from tsconfig.json's experimentalDecorators and emitDecoratorMetadata.
export default defineConfig({
  entry: ['src/server-node.ts'],
  outDir: 'dist/node',
  platform: 'node',
  target: 'es2024',
  format: ['esm'],
  fixedExtension: false,
  dts: false,
});
