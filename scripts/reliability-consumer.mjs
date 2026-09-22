import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureConsumerArchives } from './consumer-companions.mjs';

const root = new URL('../', import.meta.url);
const required = ['@velajs/reliability', '@velajs/crud', '@velajs/crud-drizzle', '@velajs/vela'];

/** Install the exact release archives, first without any optional framework/database peers. */
export async function verifyReliabilityPackage(releaseTarballs) {
  const { tarballs, companions } = await ensureConsumerArchives(releaseTarballs, required);
  const consumer = await mkdtemp(join(tmpdir(), 'vela-reliability-consumer-'));
  const versions = Object.fromEntries(
    await Promise.all(
      ['typescript', 'drizzle-orm', '@libsql/client', 'zod'].map(async (name) => [
        name,
        JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), 'utf8'))
          .version,
      ]),
    ),
  );
  await cp(new URL('tests/release/fixtures/reliability-consumer/', root), consumer, {
    recursive: true,
  });
  const manifest = {
    name: 'vela-reliability-packed-consumer',
    private: true,
    type: 'module',
    dependencies: { '@velajs/reliability': tarballs['@velajs/reliability'] },
    devDependencies: { typescript: versions.typescript },
    overrides: tarballs,
  };
  const save = () =>
    writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const run = (command, args) => execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });
  const install = (omitPeers = false) =>
    run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...(omitPeers ? ['--omit=peer'] : []),
      '--cache',
      join(consumer, '.npm-cache'),
    ]);
  await save();
  install(true);
  run('node', ['portable.mjs']);
  run('node', [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--target',
    'ES2024',
    'portable.types.ts',
  ]);
  Object.assign(
    manifest.dependencies,
    Object.fromEntries(required.map((name) => [name, tarballs[name]])),
    {
      'drizzle-orm': versions['drizzle-orm'],
      '@libsql/client': versions['@libsql/client'],
      zod: versions.zod,
    },
  );
  await save();
  install();
  run('node', ['database.mjs']);
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
  const proof = {
    path: consumer,
    status: 'passed',
    optionalPeersAbsent: true,
    archives,
    companions,
  };
  await writeFile(join(consumer, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    'PASS: packed reliability imports, replay, leases, scheduling and transactional delivery',
  );
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? '.artifacts/release');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  await verifyReliabilityPackage(
    Object.fromEntries(
      manifest.packages.map((entry) => [entry.name, `file:${join(directory, entry.filename)}`]),
    ),
  );
}
