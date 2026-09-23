#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

class GateFailure extends Error {}

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const fixturePath = resolve(scriptDirectory, 'fixtures', 'worker-size-entry.ts');
const wranglerConfigPath = resolve(scriptDirectory, 'fixtures', 'wrangler.worker-size.toml');
const baselinePath = resolve(repositoryRoot, 'worker-size.json');
const distDirectory = resolve(repositoryRoot, 'dist');
const update = process.argv.includes('--update');
const rawUploadLimitBytes = 64 * 1024 * 1024;
const gzipUploadLimitBytes = 3 * 1024 * 1024;

function fail(message) {
  throw new GateFailure(message);
}

function kibibytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function collectOutputFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectOutputFiles(entryPath));
    } else if (entry.name !== 'README.md' && !entry.name.endsWith('.map')) {
      files.push(entryPath);
    }
  }

  return files.toSorted();
}

function resolveWranglerBin() {
  let manifestPath;

  try {
    manifestPath = require.resolve('wrangler/package.json');
  } catch {
    fail('wrangler is not installed; run `pnpm install` first');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const binTarget = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.wrangler;
  if (typeof binTarget !== 'string') fail('wrangler package does not declare its CLI entry');
  return resolve(dirname(manifestPath), binTarget);
}

function bundleWorker(outputDirectory, metafilePath) {
  const result = spawnSync(
    process.execPath,
    [
      resolveWranglerBin(),
      'deploy',
      '--dry-run',
      '--config',
      wranglerConfigPath,
      '--outdir',
      outputDirectory,
      '--metafile',
      metafilePath,
      '--minify',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const diagnostics = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.error !== undefined || result.status !== 0) {
    if (diagnostics !== '') process.stderr.write(diagnostics);
    fail('Wrangler could not produce a deployable dry-run bundle');
  }

  // Wrangler can exit successfully while warning that the emitted module
  // graph will fail at runtime (for example, an unresolved Node built-in).
  // A release gate must not accept that as a deployable reference Worker.
  if (/\bWARNING\b/u.test(diagnostics)) {
    process.stderr.write(diagnostics);
    fail('Wrangler emitted a warning for the reference Worker');
  }
}

// esbuild names metafile inputs relative to Wrangler's project root, the
// directory holding the Wrangler config. Returns the package's dist modules
// in the bundle, as package-relative paths such as `dist/factory.js`.
function bundledPackageModules(metafilePath) {
  let metafile;
  try {
    metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
  } catch {
    fail('Wrangler did not write a readable esbuild metafile');
  }

  const modules = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const input of Object.keys(output.inputs ?? {})) {
      const inputPath = resolve(dirname(wranglerConfigPath), input);
      if (inputPath.startsWith(`${distDirectory}${sep}`)) {
        modules.add(relative(repositoryRoot, inputPath).split(sep).join('/'));
      }
    }
  }

  // A metafile whose paths no longer resolve would make every exclusion pass.
  if (!modules.has('dist/factory.js')) {
    fail('could not find dist/factory.js among the modules Wrangler bundled');
  }
  return modules;
}

function measureWorker() {
  if (!existsSync(resolve(repositoryRoot, 'dist', 'index.js'))) {
    fail('dist/index.js is missing; run `pnpm build` first');
  }
  if (!existsSync(baselinePath)) fail('worker-size.json is missing');

  const workDirectory = mkdtempSync(resolve(tmpdir(), 'vela-worker-size-'));
  const outputDirectory = resolve(workDirectory, 'bundle');
  const metafilePath = resolve(workDirectory, 'metafile.json');

  try {
    bundleWorker(outputDirectory, metafilePath);
    const outputPaths = collectOutputFiles(outputDirectory);
    if (outputPaths.length === 0 || !outputPaths.some((path) => path.endsWith('.js'))) {
      fail('Wrangler reported success but emitted no Worker JavaScript');
    }

    const files = outputPaths.map((path) => readFileSync(path));
    if (files.some((contents) => contents.byteLength === 0)) {
      fail('Wrangler emitted an empty deployable output file');
    }

    return {
      // Wrangler concatenates uploaded module contents into one Blob and uses
      // zlib's default gzip level. Mirror both details so multi-module output
      // stays comparable to the deploy tool and Cloudflare limit.
      gzipBytes: gzipSync(Buffer.concat(files)).byteLength,
      modules: bundledPackageModules(metafilePath),
      rawBytes: files.reduce((total, contents) => total + contents.byteLength, 0),
    };
  } finally {
    rmSync(workDirectory, { force: true, recursive: true });
  }
}

function main() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const fixtureName = relative(repositoryRoot, fixturePath).split(sep).join('/');
  if (baseline.fixture !== fixtureName) {
    fail(`worker-size.json must describe ${fixtureName}`);
  }

  for (const field of ['rawBytes', 'gzipBytes', 'rawAllowanceBytes', 'gzipAllowanceBytes']) {
    if (!Number.isSafeInteger(baseline[field]) || baseline[field] < 0) {
      fail(`worker-size.json field "${field}" must be a non-negative safe integer`);
    }
  }
  const excludedModules = baseline.excludedModules ?? [];
  if (
    !Array.isArray(excludedModules) ||
    excludedModules.some((entry) => typeof entry !== 'string' || !entry.startsWith('dist/'))
  ) {
    fail('worker-size.json field "excludedModules" must list paths that start with "dist/"');
  }
  const staleExclusions = excludedModules.filter(
    (entry) => !existsSync(resolve(repositoryRoot, entry)),
  );
  if (staleExclusions.length > 0) {
    fail(
      `worker-size.json#excludedModules names paths the build no longer emits: ${staleExclusions.join(', ')}`,
    );
  }

  const { gzipBytes, modules, rawBytes } = measureWorker();
  const rawCeiling = baseline.rawBytes + baseline.rawAllowanceBytes;
  const gzipCeiling = baseline.gzipBytes + baseline.gzipAllowanceBytes;

  process.stdout.write(
    `worker-size (${fixtureName}): ${kibibytes(rawBytes)} raw, ` +
      `${kibibytes(gzipBytes)} gzipped; ceilings ${kibibytes(rawCeiling)} raw / ` +
      `${kibibytes(gzipCeiling)} gzipped\n`,
  );

  if (rawBytes > rawUploadLimitBytes) {
    fail(
      `Worker exceeds Cloudflare's ${kibibytes(rawUploadLimitBytes)} raw upload limit; ` +
        'this cannot be accepted by updating the regression baseline',
    );
  }
  if (gzipBytes > gzipUploadLimitBytes) {
    fail(
      `Worker exceeds Cloudflare Free's ${kibibytes(gzipUploadLimitBytes)} gzip upload limit; ` +
        'this cannot be accepted by updating the regression baseline',
    );
  }

  // The byte budget has headroom, so it cannot notice one feature creeping back
  // into a Worker that never uses it. Name each such module instead: a module
  // or directory listed here must stay out of the reference Worker.
  const unexpectedModules = [...modules].filter((module) =>
    excludedModules.some((entry) =>
      entry.endsWith('/') ? module.startsWith(entry) : module === entry,
    ),
  );
  if (unexpectedModules.length > 0) {
    fail(
      `the reference Worker bundles ${unexpectedModules.join(', ')}, which ` +
        'worker-size.json#excludedModules keeps out of a Worker that never uses them. ' +
        'Look for a new import from the boot path, an eager registration, or a top-level ' +
        'statement that keeps the module alive.',
    );
  }

  if (update) {
    const updatedBaseline = { ...baseline, gzipBytes, rawBytes };
    writeFileSync(baselinePath, `${JSON.stringify(updatedBaseline, undefined, 2)}\n`);
    process.stdout.write('worker-size: updated worker-size.json; review the byte delta\n');
    return;
  }

  const violations = [];
  if (rawBytes > rawCeiling) {
    violations.push(
      `raw bundle is ${kibibytes(rawBytes - rawCeiling)} over its ${kibibytes(rawCeiling)} ceiling`,
    );
  }
  if (gzipBytes > gzipCeiling) {
    violations.push(
      `gzipped bundle is ${kibibytes(gzipBytes - gzipCeiling)} over its ${kibibytes(gzipCeiling)} ceiling`,
    );
  }

  if (violations.length > 0) {
    fail(
      `${violations.join('; ')}. Investigate the deployable Worker, or run ` +
        '`pnpm worker-size:update` for an intentional increase and review worker-size.json.',
    );
  }

  process.stdout.write('worker-size: Wrangler bundle remains within its regression budget\n');
}

try {
  main();
} catch (error) {
  if (!(error instanceof GateFailure)) throw error;
  process.stderr.write(`worker-size: ${error.message}\n`);
  process.exitCode = 1;
}
