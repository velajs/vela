import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/client/index.ts', 'src/standalone/index.ts'],
  format: ['esm'],
  dts: true,
  // Build-only tsconfig that excludes __tests__. Typecheck (`tsc --noEmit`) still
  // uses tsconfig.json (which covers tests); the dts pass must not, or it would
  // compile the cross-package relative imports in tests and scatter stray .d.ts
  // into sibling package sources.
  tsconfig: './tsconfig.build.json',
  clean: true,
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
  // Ship the scoped stylesheet alongside the bundle: consumers import
  // `@velajs/studio-ui/dist/styles.css`. The .tsx modules transform to React 19's
  // automatic JSX runtime (oxc default). See report for the scoping mechanism.
  copy: [{ from: 'src/styles.css', to: 'dist' }],
});
