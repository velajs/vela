/* eslint-disable no-console -- Verification command output. */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Build and run the multi-worker example against the exact packed public packages. */
export async function verifyModuleWorkers(tarballs) {
  const required = ['@velajs/vela', '@velajs/cloudflare', '@velajs/rpc'];
  for (const name of required)
    if (!tarballs[name]) throw new Error(`Module worker proof requires ${name}`);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = join(root, 'apps/module-workers');
  const consumer = await mkdtemp(join(tmpdir(), 'vela-module-workers-consumer-'));
  await cp(source, consumer, {
    recursive: true,
    filter: (path) => !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(path),
  });
  const manifest = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'));
  const installed = JSON.parse(
    execFileSync('pnpm', ['--filter', manifest.name, 'list', '--depth', '0', '--json'], {
      cwd: source,
      encoding: 'utf8',
    }),
  ).find((entry) => entry.name === manifest.name);
  if (!installed)
    throw new Error('Install the module-workers example before consumer verification');
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[field])) {
      manifest[field][name] =
        tarballs[name] ?? (range.startsWith('catalog:') ? installed[field][name].version : range);
      if (manifest[field][name].startsWith('workspace:'))
        throw new Error(`Missing packed dependency ${name}`);
    }
  }
  manifest.overrides = tarballs;
  await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: consumer, stdio: 'inherit' });
  // A private cache, as in the other consumers: the shared npm cache can hold
  // stale metadata for an earlier archive with the same name and version.
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    join(consumer, '.npm-cache'),
  ]);
  run('npm', ['run', 'build']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'test:workers']);
  const archives = Object.fromEntries(
    await Promise.all(
      required.map(async (name) => [
        name,
        `sha512-${createHash('sha512')
          .update(await readFile(tarballs[name].slice(5)))
          .digest('base64')}`,
      ]),
    ),
  );
  return { path: consumer, status: 'passed', archives };
}
