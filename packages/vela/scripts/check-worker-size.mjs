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

function bundleWorker(outputDirectory) {
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

function measureWorker() {
  if (!existsSync(resolve(repositoryRoot, 'dist', 'index.js'))) {
    fail('dist/index.js is missing; run `pnpm build` first');
  }
  if (!existsSync(baselinePath)) fail('worker-size.json is missing');

  const outputDirectory = mkdtempSync(resolve(tmpdir(), 'vela-worker-size-'));

  try {
    bundleWorker(outputDirectory);
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
      rawBytes: files.reduce((total, contents) => total + contents.byteLength, 0),
    };
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
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

  const { gzipBytes, rawBytes } = measureWorker();
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
