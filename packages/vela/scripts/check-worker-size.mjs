#!/usr/bin/env node

// Measures a reference Worker as Wrangler deploys it and holds it to a
// committed byte budget. `--baseline <file>` names the budget (default:
// packages/vela/worker-size.json); its `fixture` entry is relative to the
// budget's directory, and `wrangler.worker-size.toml` sits next to the fixture.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

class GateFailure extends Error {}

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const velaDirectory = resolve(scriptDirectory, '..');
const update = process.argv.includes('--update');
const baselineFlag = process.argv.indexOf('--baseline');
const baselinePath =
  baselineFlag === -1
    ? resolve(velaDirectory, 'worker-size.json')
    : resolve(process.argv[baselineFlag + 1] ?? '');
const baselineDirectory = dirname(baselinePath);
const baselineName = basename(baselinePath);
const rawUploadLimitBytes = 64 * 1024 * 1024;
const gzipUploadLimitBytes = 3 * 1024 * 1024;

function fail(message) {
  throw new GateFailure(message);
}

function kibibytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function exactBytes(count) {
  return `${count.toLocaleString('en-US')} bytes`;
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail(`${description} is missing or not valid JSON`);
  }
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

/**
 * The packages whose dist modules the budget names. An `excludedModules` entry
 * is `dist/…` in the budget's own package, or `<package>/dist/…` in a
 * dependency linked into its node_modules.
 */
function packageOf(entry, packages) {
  const match = /^((?:@[^/]+\/)?[^/@][^/]*)\/(dist\/.*)$/u.exec(entry);
  const name = entry.startsWith('dist/') ? packages.own : match?.[1];
  const path = entry.startsWith('dist/') ? entry : match?.[2];
  if (name === undefined || path === undefined) {
    fail(
      `${baselineName} field "excludedModules" must list paths that start with "dist/" or ` +
        `"<package>/dist/"; got "${entry}"`,
    );
  }
  let directory = packages.directories.get(name);
  if (directory === undefined) {
    const linked = resolve(baselineDirectory, 'node_modules', name);
    if (!existsSync(linked)) fail(`${baselineName} names ${name}, which is not installed here`);
    directory = realpathSync(linked);
    packages.directories.set(name, directory);
  }
  return { directory, name, path };
}

function bundleWorker(wranglerConfigPath, outputDirectory, metafilePath) {
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
      cwd: baselineDirectory,
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
// directory holding the Wrangler config. Returns the named packages' dist
// modules in the bundle, as `dist/factory.js` for the budget's own package
// and `@velajs/vela/dist/factory.js` for another one.
function bundledPackageModules(metafilePath, wranglerConfigPath, packages) {
  let metafile;
  try {
    metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
  } catch {
    fail('Wrangler did not write a readable esbuild metafile');
  }

  const modules = new Set();
  const found = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const input of Object.keys(output.inputs ?? {})) {
      const inputPath = resolve(dirname(wranglerConfigPath), input);
      for (const [name, directory] of packages.directories) {
        if (!inputPath.startsWith(`${directory}${sep}dist${sep}`)) continue;
        const path = relative(directory, inputPath).split(sep).join('/');
        modules.add(name === packages.own ? path : `${name}/${path}`);
        found.add(name);
      }
    }
  }

  // A metafile whose paths no longer resolve would make every exclusion pass.
  for (const name of packages.directories.keys()) {
    if (!found.has(name)) {
      fail(`could not find any ${name} dist module among the modules Wrangler bundled`);
    }
  }
  return modules;
}

function measureWorker(fixturePath, packages) {
  for (const directory of packages.directories.values()) {
    if (!existsSync(resolve(directory, 'dist', 'index.js'))) {
      fail(
        `${relative(process.cwd(), directory) || '.'}/dist/index.js is missing; run \`pnpm build\` first`,
      );
    }
  }
  const wranglerConfigPath = resolve(dirname(fixturePath), 'wrangler.worker-size.toml');
  if (!existsSync(wranglerConfigPath)) {
    fail(`${relative(baselineDirectory, wranglerConfigPath)} is missing next to the fixture`);
  }

  const workDirectory = mkdtempSync(resolve(tmpdir(), 'vela-worker-size-'));
  const outputDirectory = resolve(workDirectory, 'bundle');
  const metafilePath = resolve(workDirectory, 'metafile.json');

  try {
    bundleWorker(wranglerConfigPath, outputDirectory, metafilePath);
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
      modules: bundledPackageModules(metafilePath, wranglerConfigPath, packages),
      rawBytes: files.reduce((total, contents) => total + contents.byteLength, 0),
    };
  } finally {
    rmSync(workDirectory, { force: true, recursive: true });
  }
}

function main() {
  const baseline = readJson(baselinePath, baselineName);
  const manifest = readJson(resolve(baselineDirectory, 'package.json'), 'package.json');
  if (typeof baseline.fixture !== 'string' || baseline.fixture === '') {
    fail(`${baselineName} field "fixture" must name the reference Worker`);
  }
  const fixturePath = resolve(baselineDirectory, baseline.fixture);
  const fixtureName = relative(baselineDirectory, fixturePath).split(sep).join('/');
  if (!existsSync(fixturePath)) fail(`${baselineName} names a missing fixture, ${fixtureName}`);

  for (const field of ['rawBytes', 'gzipBytes', 'rawAllowanceBytes', 'gzipAllowanceBytes']) {
    if (!Number.isSafeInteger(baseline[field]) || baseline[field] < 0) {
      fail(`${baselineName} field "${field}" must be a non-negative safe integer`);
    }
  }
  const excludedModules = baseline.excludedModules ?? [];
  if (
    !Array.isArray(excludedModules) ||
    excludedModules.some((entry) => typeof entry !== 'string')
  ) {
    fail(`${baselineName} field "excludedModules" must list module paths`);
  }
  const packages = {
    own: manifest.name,
    directories: new Map([[manifest.name, baselineDirectory]]),
  };
  const exclusions = excludedModules.map((entry) => ({ entry, ...packageOf(entry, packages) }));
  const staleExclusions = exclusions
    .filter(({ directory, path }) => !existsSync(resolve(directory, path)))
    .map(({ entry }) => entry);
  if (staleExclusions.length > 0) {
    fail(
      `${baselineName}#excludedModules names paths the build no longer emits: ${staleExclusions.join(', ')}`,
    );
  }

  const { gzipBytes, modules, rawBytes } = measureWorker(fixturePath, packages);
  const rawCeiling = baseline.rawBytes + baseline.rawAllowanceBytes;
  const gzipCeiling = baseline.gzipBytes + baseline.gzipAllowanceBytes;

  process.stdout.write(
    `worker-size (${manifest.name} ${fixtureName}): ${exactBytes(rawBytes)} raw ` +
      `(${kibibytes(rawBytes)}), ${exactBytes(gzipBytes)} gzipped (${kibibytes(gzipBytes)}); ` +
      `ceilings ${kibibytes(rawCeiling)} raw / ${kibibytes(gzipCeiling)} gzipped\n`,
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
        `${baselineName}#excludedModules keeps out of a Worker that never uses them. ` +
        'Look for a new import from the boot path, an eager registration, or a top-level ' +
        'statement that keeps the module alive.',
    );
  }

  if (update) {
    const updatedBaseline = { ...baseline, gzipBytes, rawBytes };
    writeFileSync(baselinePath, `${JSON.stringify(updatedBaseline, undefined, 2)}\n`);
    process.stdout.write(`worker-size: updated ${baselineName}; review the byte delta\n`);
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
        `\`pnpm worker-size:update\` for an intentional increase and review ${baselineName}.`,
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
