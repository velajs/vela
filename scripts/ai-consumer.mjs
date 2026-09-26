import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const versionOf = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8')).version;

/** Verify public entrypoints independently of api-starter and provider packages. */
export async function verifyAiPackage(tarball) {
  const archive = resolve(tarball);
  const consumer = await mkdtemp(join(tmpdir(), 'vela-ai-consumer-'));
  const [ai, zod, typescript, nodeTypes] = await Promise.all([
    versionOf('packages/ai/node_modules/ai/package.json'),
    versionOf('packages/ai/node_modules/zod/package.json'),
    versionOf('node_modules/typescript/package.json'),
    versionOf('node_modules/@types/node/package.json'),
  ]);
  await cp(new URL('tests/release/fixtures/ai-consumer/', root), consumer, { recursive: true });
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'vela-ai-packed-consumer',
        private: true,
        type: 'module',
        dependencies: { '@velajs/ai': `file:${archive}`, ai, zod },
        devDependencies: { typescript, '@types/node': nodeTypes },
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
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit']);
  run('node', ['smoke.mjs']);
  const proof = {
    path: consumer,
    status: 'passed',
    package: '@velajs/ai',
    subpaths: ['.', './rag', './ai-search', './vectorize'],
    ai,
    zod,
    archiveIntegrity: `sha512-${createHash('sha512')
      .update(await readFile(archive))
      .digest('base64')}`,
  };
  await writeFile(join(consumer, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  process.stdout.write(
    `PASS: packed @velajs/ai base, /rag , /ai-search and /vectorize imports, types, tools and tenant isolation (${consumer})\n`,
  );
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2])
    throw new Error('Usage: node scripts/ai-consumer.mjs /absolute/path/to/package.tgz');
  await verifyAiPackage(process.argv[2]);
}
