import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureConsumerArchives } from './consumer-companions.mjs';

const root = new URL('../', import.meta.url);
const required = [
  '@velajs/vela',
  '@velajs/client',
  '@velajs/cli',
  '@velajs/crud',
  '@velajs/crud-drizzle',
];

/** Exercise public API contracts against the exact archives outside the workspace. */
export async function verifyApiCapabilities(releaseTarballs) {
  const { tarballs, companions } = await ensureConsumerArchives(releaseTarballs, required);
  const consumer = await mkdtemp(join(tmpdir(), 'vela-api-capabilities-consumer-'));
  const version = async (name) =>
    JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), 'utf8')).version;
  const [typescript, zod, hono, drizzle, libsql] = await Promise.all(
    ['typescript', 'zod', 'hono', 'drizzle-orm', '@libsql/client'].map(version),
  );
  await cp(new URL('tests/release/fixtures/api-capabilities/', root), consumer, {
    recursive: true,
  });
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'vela-api-capabilities-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(required.map((name) => [name, tarballs[name]])),
          zod,
          hono,
          'drizzle-orm': drizzle,
          '@libsql/client': libsql,
        },
        devDependencies: { typescript },
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
  run('node', ['runtime.mjs']);
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit']);
  const archives = Object.fromEntries(
    await Promise.all(
      required.map(async (name) => [
        name,
        `sha512-${createHash('sha512')
          .update(await readFile(tarballs[name].slice('file:'.length)))
          .digest('base64')}`,
      ]),
    ),
  );
  const proof = { path: consumer, status: 'passed', archives, companions };
  await writeFile(join(consumer, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    'PASS: packed HTTP forms, streams, telemetry, caching, transactional history and atomic writes',
  );
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? '.artifacts/release');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  await verifyApiCapabilities(
    Object.fromEntries(
      manifest.packages.map((entry) => [entry.name, `file:${join(directory, entry.filename)}`]),
    ),
  );
}
