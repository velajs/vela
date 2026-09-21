import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

/** Verify testing and its framework against exact archives outside any workspace. */
export async function verifyTestingPackage(tarballs) {
  const packages = ['@velajs/testing', '@velajs/vela', '@velajs/errors', '@velajs/live-protocol'];
  for (const name of packages) {
    if (!tarballs[name]) throw new Error(`Testing consumer requires the packed ${name} archive`);
  }
  const consumer = await mkdtemp(join(tmpdir(), 'vela-testing-consumer-'));
  const versions = Object.fromEntries(
    await Promise.all(
      ['typescript', 'vitest', 'hono'].map(async (name) => [
        name,
        JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), 'utf8'))
          .version,
      ]),
    ),
  );
  await cp(new URL('tests/release/fixtures/testing-consumer/', root), consumer, {
    recursive: true,
  });
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'vela-testing-packed-consumer',
        private: true,
        type: 'module',
        dependencies: Object.fromEntries(packages.map((name) => [name, tarballs[name]])),
        devDependencies: versions,
        overrides: tarballs,
      },
      null,
      2,
    ) + '\n',
  );
  const run = (command, args) => execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    join(consumer, '.npm-cache'),
  ]);
  run('npx', ['--no-install', 'tsc', '--noEmit']);
  run('npx', ['--no-install', 'vitest', 'run', '--maxWorkers=1']);
  return { path: consumer, status: 'passed', optionalNodePeersAbsent: true, packages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifactDir = resolve(process.argv[2] ?? '.artifacts/release');
  const artifacts = JSON.parse(await readFile(join(artifactDir, 'manifest.json'), 'utf8'));
  const tarballs = Object.fromEntries(
    artifacts.packages.map((entry) => [entry.name, `file:${join(artifactDir, entry.filename)}`]),
  );
  const proof = await verifyTestingPackage(tarballs);
  await writeFile(
    join(artifactDir, 'testing-consumer.json'),
    JSON.stringify(proof, null, 2) + '\n',
  );
}
