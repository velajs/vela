/**
 * Build the standalone browser bundle `@velajs/studio-host` serves.
 *
 * esbuild bundles a synthetic entry — `import { mountStudio } from
 * '../src/standalone'; mountStudio()` — with React and every dependency inlined,
 * code-split (`splitting: true`) so each `React.lazy(() => import('../panels/*'))`
 * boundary in the shell becomes its own `chunk-*.js`. Output lands in
 * `dist/standalone/`:
 *
 *   studio.js        the bundle entry (auto-mounts, reading window.__VELA_*)
 *   chunk-*.js       per-panel code-split chunks
 *   styles.css       the scoped stylesheet, copied verbatim (scoping preserved)
 *
 * The bundle runs in the browser only — no Node builtins — so it stays
 * edge-safe. This script is Node build tooling and is never shipped.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const standaloneSrc = join(pkgRoot, 'src', 'standalone');
const outdir = join(pkgRoot, 'dist', 'standalone');

mkdirSync(outdir, { recursive: true });

const result = await build({
  stdin: {
    // The synthetic browser entry: mountStudio already reads the window.__VELA_*
    // globals, so the entry just invokes it once on load.
    contents: "import { mountStudio } from './index';\nmountStudio();\n",
    resolveDir: standaloneSrc,
    sourcefile: 'studio-bootstrap.tsx',
    loader: 'tsx',
  },
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  outdir,
  entryNames: 'studio',
  chunkNames: 'chunk-[hash]',
  assetNames: 'asset-[hash]',
  minify: true,
  sourcemap: true,
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

// Ship the scoped stylesheet beside the bundle, verbatim (no recompile → the
// existing scoping mechanism is preserved). The host serves it at styles.css.
copyFileSync(join(pkgRoot, 'src', 'styles.css'), join(outdir, 'styles.css'));

// Emit the esbuild metafile for build inspection / chunk evidence.
writeFileSync(join(outdir, 'metafile.json'), JSON.stringify(result.metafile), 'utf8');

const outputs = Object.keys(result.metafile.outputs)
  .map((p) => p.replace(`${pkgRoot}/`, '').replace('dist/standalone/', ''))
  .filter((name) => name.endsWith('.js'))
  .sort();
console.warn(`[studio-ui] standalone bundle: ${outputs.join(', ')}`);
