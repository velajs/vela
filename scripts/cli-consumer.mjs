import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
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
  // The committed binding types are exactly what this Wrangler generates.
  const bindingTypes = join(project, 'worker-configuration.d.ts');
  const committedTypes = await readFile(bindingTypes, 'utf8');
  assert.match(committedTypes, /declare namespace Cloudflare/);
  run(['types']);
  assert.equal(await readFile(bindingTypes, 'utf8'), committedTypes);
  run(['typecheck']);
  // Vite builds src/worker.ts with Oxc; no precompile step writes dist/ first.
  run(['build']);
  const deployConfig = JSON.parse(
    await readFile(join(project, '.wrangler/deploy/config.json'), 'utf8'),
  );
  const builtConfigPath = resolve(project, '.wrangler/deploy', deployConfig.configPath);
  const builtConfig = JSON.parse(await readFile(builtConfigPath, 'utf8'));
  const bundle = await readFile(join(dirname(builtConfigPath), builtConfig.main), 'utf8');
  assert.match(bundle, /design:paramtypes/);
  assert.match(bundle, /class AppController/, 'The Worker build keeps class names');
  // The template spec drives the Worker through createTestingWorker inside workerd.
  run(['test']);
  // Without a vela.config, the pinned CLI loads the Worker entry Wrangler names
  // and its decorated sources through Vite.
  assert.equal(existsSync(join(project, 'vela.config.ts')), false);
  const vela = (args) =>
    execFileSync('pnpm', ['exec', 'vela', ...args], { cwd: project, encoding: 'utf8' });
  const routes = vela(['route', 'list', '--json']);
  assert.deepEqual(
    JSON.parse(routes).map(({ method, path }) => `${method} ${path}`),
    ['GET /'],
  );
  run(['run', 'deploy', '--dry-run', '--outdir', 'worker-bundle']);

  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close((error) => (error ? reject(error) : done())));

  const child = spawn(
    'pnpm',
    ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: project,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
        throw new Error(`vite dev exited before serving the expected response.\n${logs}`);
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
    throw new Error(`vite dev did not serve ${JSON.stringify(message)}.\n${logs}`, {
      cause: lastError,
    });
  }
  try {
    await expectMessage('Hello from Vela!');
    const service = join(project, 'src/app.service.ts');
    const source = await readFile(service, 'utf8');
    // Only edit the injected service: proves metadata, DI and the dev reload.
    // Each edit writes new content after the watcher settles; rewriting the
    // original text right after a reload can be coalesced and never reported.
    for (const message of ['Hello from the injected service!', 'Hello again from Vela!']) {
      await delay(500);
      await writeFile(service, source.replace('Hello from Vela!', message));
      await expectMessage(message);
    }
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
  await verifyGenerators(project, vela, run);
  const api = await verifyApiTemplate(consumer, runCli, archives);
  console.log(
    'PASS: packed vela new (minimal and api templates), failure cases, registry install, types, Vite build, workerd specs, zero-config CLI, generators, cf sync, deploy check, Worker bundle, HTTP, DI and dev reload',
  );
  return { project, api };
}

/** Grow the scaffold with every generator, then keep it typed, tested, synced and deployable. */
async function verifyGenerators(project, vela, run) {
  for (const args of [
    ['generate', 'resource', 'notes'],
    ['g', 'queue', 'emails'],
    ['g', 'cron', 'digest', '--schedule', '0 6 * * *'],
    ['g', 'durable-object', 'counter'],
  ]) {
    vela(args);
  }
  const app = await readFile(join(project, 'src/app.module.ts'), 'utf8');
  for (const registered of [
    'NotesModule',
    'EmailsProcessor',
    'DigestCron',
    'QueueModule.forRoot({ driver: cloudflareQueues() })',
  ]) {
    assert.ok(app.includes(registered), `AppModule registers ${registered}`);
  }
  assert.match(await readFile(join(project, 'src/worker.ts'), 'utf8'), /export \{ Counter \}/);
  // The Wrangler file is out of date until cf sync writes the new triggers and bindings.
  assert.throws(() => vela(['cf', 'sync']), /Command failed/);
  vela(['cf', 'sync', '--write']);
  vela(['cf', 'sync']);
  run(['types']);
  const types = await readFile(join(project, 'worker-configuration.d.ts'), 'utf8');
  assert.match(types, /EMAILS: Queue;/);
  assert.match(types, /COUNTER: DurableObjectNamespace/);
  run(['typecheck']);
  run(['test']);
  vela(['deploy', 'check']);
  const routes = JSON.parse(vela(['route', 'list', '--json'])).map(
    ({ method, path }) => `${method} ${path}`,
  );
  assert.ok(routes.includes('POST /notes') && routes.includes('GET /notes/:id'), routes.join(', '));
  run(['run', 'deploy', '--dry-run', '--outdir', 'worker-bundle']);
}

/** The api template installs, typechecks, passes its workerd specs and matches its Wrangler file. */
async function verifyApiTemplate(consumer, runCli, archives) {
  const generated = runCli(['new', 'todo-api', '--template', 'api']);
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const project = join(consumer, 'todo-api');
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const overrides = Object.entries(starterArchiveOverrides(manifest, archives));
  if (overrides.length) {
    await appendFile(
      join(project, 'pnpm-workspace.yaml'),
      `overrides:\n${overrides.map(([name, spec]) => `  '${name}': '${spec}'\n`).join('')}`,
    );
  }
  const run = (args) => execFileSync('pnpm', args, { cwd: project, stdio: 'inherit' });
  const vela = (args) =>
    execFileSync('pnpm', ['exec', 'vela', ...args], { cwd: project, encoding: 'utf8' });
  run(['install']);
  const bindingTypes = join(project, 'worker-configuration.d.ts');
  const committedTypes = await readFile(bindingTypes, 'utf8');
  run(['typecheck']);
  assert.equal(await readFile(bindingTypes, 'utf8'), committedTypes);
  run(['test']);
  vela(['cf', 'sync']);
  vela(['deploy', 'check']);
  run(['build']);
  return project;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2])
    throw new Error(
      'Usage: node scripts/cli-consumer.mjs <installed-cli-dist/index.js> [archives-json]',
    );
  await verifyNewProject(resolve(process.argv[2]), JSON.parse(process.argv[3] ?? '{}'));
}
