import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const subpaths = [
  '@velajs/mail',
  '@velajs/mail/transports/resend',
  '@velajs/mail/transports/catcher',
  '@velajs/mail/testing',
];

/** Mail is absent from api-starter: prove its own archive, including optional peers. */
export async function verifyMailPackage(tarballs) {
  if (!tarballs['@velajs/mail']) throw new Error('Mail consumer requires the packed mail archive');
  const consumer = await mkdtemp(join(tmpdir(), 'vela-mail-consumer-'));
  const ts = JSON.parse(
    await readFile(new URL('node_modules/typescript/package.json', root), 'utf8'),
  );
  const vela = JSON.parse(await readFile(new URL('packages/vela/package.json', root), 'utf8'));
  const manifest = {
    name: 'vela-mail-packed-consumer',
    private: true,
    type: 'module',
    dependencies: { '@velajs/mail': tarballs['@velajs/mail'] },
    devDependencies: { typescript: ts.version },
  };
  const save = () =>
    writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const run = (command, args) => execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });
  const install = () => run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  await cp(new URL('tests/release/fixtures/mail/', root), consumer, { recursive: true });
  await save();
  install();
  // At this point there must be no framework installed, even as an optional peer.
  run('node', ['standalone.mjs']);
  run('npx', [
    '--no-install',
    'tsc',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--target',
    'ES2024',
    'standalone.ts',
  ]);

  manifest.dependencies['@velajs/vela'] = tarballs['@velajs/vela'] ?? vela.version;
  manifest.overrides = tarballs;
  await save();
  install();
  run('node', ['integration.mjs']);
  run('npx', [
    '--no-install',
    'tsc',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--target',
    'ES2024',
    'integration.ts',
  ]);
  console.log(
    `PASS: packed mail subpaths, optional-peer isolation and Vela integration (${consumer})`,
  );
  return { path: consumer, subpaths, standalone: true, status: 'passed' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifactDir = resolve(process.argv[2] ?? '.artifacts/release');
  const artifacts = JSON.parse(await readFile(join(artifactDir, 'manifest.json'), 'utf8'));
  const tarballs = Object.fromEntries(
    artifacts.packages.map((entry) => [entry.name, `file:${join(artifactDir, entry.filename)}`]),
  );
  const proof = await verifyMailPackage(tarballs);
  await writeFile(join(artifactDir, 'mail-consumer.json'), JSON.stringify(proof, null, 2) + '\n');
}
