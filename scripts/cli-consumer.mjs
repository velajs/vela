import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { starterArchiveOverrides } from './starter-pins.mjs';

// The entrypoint must come from an installed tarball, never the workspace dist.
// `archives` maps package names to `file:` release archives: the starter pins
// the framework versions released with the CLI, which are not on npm yet. Omit
// it to check a published CLI against npm alone.
export async function verifyNewProject(cliEntrypoint, archives = {}) {
  const consumer = await mkdtemp(join(tmpdir(), 'vela-new-consumer-'));
  const runCli = (args) =>
    spawnSync(process.execPath, [cliEntrypoint, ...args], {
      cwd: consumer,
      encoding: 'utf8',
    });
  const generated = runCli(['new', 'my-api']);
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  assert.match(generated.stdout, /pnpm install/);
  const project = join(consumer, 'my-api');
  const manifestPath = join(project, 'package.json');
  const original = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  assert.equal(manifest.name, 'my-api');
  for (const range of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(range, /^\d+\.\d+\.\d+$/, 'Starter dependencies must be published versions');
  }
  assert.match(await readFile(join(project, '.gitignore'), 'utf8'), /node_modules/);
  const version = runCli(['--version']);
  assert.equal(version.status, 0, version.stdout + version.stderr);
  const cliManifest = JSON.parse(
    await readFile(join(dirname(cliEntrypoint), '../package.json'), 'utf8'),
  );
  assert.equal(version.stdout.trim(), cliManifest.version);

  // Exercise the packed command's parser and filesystem protection, too.
  await mkdir(join(consumer, 'hidden'));
  await writeFile(join(consumer, 'hidden', '.keep'), 'keep me');
  await writeFile(join(consumer, 'file'), 'keep me');
  await mkdir(join(consumer, 'target'));
  await symlink(join(consumer, 'target'), join(consumer, 'linked'), 'dir');
  for (const args of [
    ['new', 'my-api'],
    ['new', 'hidden'],
    ['new', 'file'],
    ['new', 'linked'],
    ['new'],
    ['new', '../escape'],
    ['new', 'BadName'],
    ['new', 'my-api', '--force'],
    ['new', 'my-api', 'extra'],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  }
  assert.equal(await readFile(manifestPath, 'utf8'), original);
  assert.equal(await readFile(join(consumer, 'hidden', '.keep'), 'utf8'), 'keep me');
  assert.deepEqual(await readdir(join(consumer, 'hidden')), ['.keep']);
  assert.equal(await readFile(join(consumer, 'file'), 'utf8'), 'keep me');
  assert.deepEqual(await readdir(join(consumer, 'target')), []);
  await mkdir(join(consumer, 'empty'));
  const empty = runCli(['new', 'empty']);
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);

  console.log(`Generated CLI consumer: ${project}`);
  const run = (args) => execFileSync('pnpm', args, { cwd: project, stdio: 'inherit' });
  // Deliberately keep the generated manifest unchanged. Its framework pins and
  // their framework dependencies resolve to the release archives; every other
  // dependency installs from npm.
  const overrides = Object.entries(starterArchiveOverrides(manifest, archives));
  if (overrides.length) {
    await appendFile(
      join(project, 'pnpm-workspace.yaml'),
      `overrides:\n${overrides.map(([name, spec]) => `  '${name}': '${spec}'\n`).join('')}`,
    );
  }
  run(['install']);
  const worker = await readFile(join(project, 'src/worker.ts'), 'utf8');
  assert.match(worker, /export default createCloudflareWorker\(AppModule\);/);
  assert.doesNotMatch(worker, /InjectionToken/);
  // pretypecheck regenerates the committed binding types with `wrangler types`.
  run(['typecheck']);
  assert.match(
    await readFile(join(project, 'worker-configuration.d.ts'), 'utf8'),
    /declare namespace Cloudflare/,
  );
  run(['build']);
  assert.match(
    await readFile(join(project, 'dist/app.controller.js'), 'utf8'),
    /design:paramtypes/,
  );
  run(['run', 'deploy', '--dry-run', '--outdir', 'worker-bundle']);

  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close((error) => (error ? reject(error) : done())));

  const child = spawn('pnpm', ['dev', '--ip', '127.0.0.1', '--port', String(port)], {
    cwd: project,
    detached: process.platform !== 'win32',
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const collect = (chunk) => {
    logs = (logs + chunk).slice(-20_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let spawnError;
  const closed = new Promise((done) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', done);
  });
  async function expectMessage(message) {
    const deadline = Date.now() + 90_000;
    let lastError;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Wrangler exited before serving the expected response.\n${logs}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.deepEqual(await response.json(), { message });
        return;
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }
    throw new Error(`Wrangler did not serve ${JSON.stringify(message)}.\n${logs}`, {
      cause: lastError,
    });
  }
  try {
    await expectMessage('Hello from Vela!');
    const service = join(project, 'src/app.service.ts');
    const source = await readFile(service, 'utf8');
    // Only edit the injected service: proves metadata, DI and the dev rebuild.
    await writeFile(
      service,
      source.replace('Hello from Vela!', 'Hello from the injected service!'),
    );
    await expectMessage('Hello from the injected service!');
    await writeFile(service, source);
    await expectMessage('Hello from Vela!');
  } finally {
    const stop = (signal) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    };
    stop('SIGTERM');
    const force = setTimeout(() => stop('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
  console.log(
    'PASS: packed vela new, failure cases, registry install, types, build, Worker bundle, HTTP, DI and dev rebuild',
  );
  return project;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2])
    throw new Error(
      'Usage: node scripts/cli-consumer.mjs <installed-cli-dist/index.js> [archives-json]',
    );
  await verifyNewProject(resolve(process.argv[2]), JSON.parse(process.argv[3] ?? '{}'));
}
