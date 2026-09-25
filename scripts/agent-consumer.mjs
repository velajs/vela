import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const required = [
  '@velajs/agent',
  '@velajs/ai',
  '@velajs/workflow',
  '@velajs/mail',
  '@velajs/errors',
  '@velajs/vela',
];

/** Test the exact agent and integration archives, independently of api-starter. */
export async function verifyAgentPackage(releaseTarballs) {
  if (!releaseTarballs['@velajs/agent']?.startsWith('file:')) {
    throw new Error('Agent consumer requires the exact release archive');
  }
  const tarballs = { ...releaseTarballs };
  const companions = await mkdtemp(join(tmpdir(), 'vela-agent-companions-'));
  // Unchanged integration packages need not appear in release-plan.json. Pack
  // their built workspace versions for this fixture without adding them to the
  // publication plan or falling back to obsolete standalone registry packages.
  for (const name of required) {
    if (tarballs[name]) continue;
    const pkg = new URL(`packages/${name.slice('@velajs/'.length)}/`, root);
    const manifest = JSON.parse(await readFile(new URL('package.json', pkg), 'utf8'));
    execFileSync('pnpm', ['pack', '--pack-destination', companions], { cwd: pkg, stdio: 'pipe' });
    tarballs[name] =
      `file:${join(companions, `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)}`;
  }
  const consumer = await mkdtemp(join(tmpdir(), 'vela-agent-consumer-'));
  const versionOf = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8')).version;
  const [ai, zod, typescript, nodeTypes, workersTypes, wrangler] = await Promise.all([
    versionOf('packages/agent/node_modules/ai/package.json'),
    versionOf('packages/agent/node_modules/zod/package.json'),
    versionOf('node_modules/typescript/package.json'),
    versionOf('node_modules/@types/node/package.json'),
    versionOf('node_modules/@cloudflare/workers-types/package.json'),
    versionOf('node_modules/wrangler/package.json'),
  ]);
  await cp(new URL('tests/release/fixtures/agent-consumer/', root), consumer, { recursive: true });
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'vela-agent-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(required.map((name) => [name, tarballs[name]])),
          ai,
          zod,
        },
        devDependencies: {
          typescript,
          '@types/node': nodeTypes,
          '@cloudflare/workers-types': workersTypes,
          wrangler,
        },
        overrides: tarballs,
      },
      null,
      2,
    ) + '\n',
  );
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: consumer, stdio: 'inherit' });
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    join(consumer, '.npm-cache'),
  ]);
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit']);
  run('node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.cloudflare.json']);
  run('node', [
    'node_modules/wrangler/bin/wrangler.js',
    'deploy',
    '--dry-run',
    '--outdir',
    'bundle',
  ]);
  run('node', ['smoke.mjs']);
  run('node', ['optional.mjs']);
  const archives = {};
  for (const name of required) {
    archives[name] = `sha512-${createHash('sha512')
      .update(await readFile(tarballs[name].slice(5)))
      .digest('base64')}`;
  }
  const proof = {
    path: consumer,
    status: 'passed',
    package: '@velajs/agent',
    subpaths: ['.', './mcp', './testing', './cloudflare'],
    archives,
  };
  await writeFile(join(consumer, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    `PASS: packed agent + workflow + AI + mail, approvals, duplicate delivery, optional imports (${consumer})`,
  );
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2])
    throw new Error('Usage: node scripts/agent-consumer.mjs /path/to/artifact-directory');
  const dir = resolve(process.argv[2]);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  await verifyAgentPackage(
    Object.fromEntries(
      manifest.packages.map((entry) => [entry.name, `file:${join(dir, entry.filename)}`]),
    ),
  );
}
