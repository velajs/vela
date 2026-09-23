import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const required = [
  '@velajs/graphql',
  '@velajs/vela',
  '@velajs/cloudflare',
  '@velajs/errors',
  '@velajs/live-protocol',
];

/** Check exact installed archives; missing companions are packed without changing the release plan. */
export async function verifyGraphqlPackage(releaseTarballs) {
  const tarballs = { ...releaseTarballs };
  const companions = await mkdtemp(join(tmpdir(), 'vela-graphql-companions-'));
  for (const name of required) {
    if (tarballs[name]) continue;
    const directory = new URL(`packages/${name.slice('@velajs/'.length)}/`, root);
    const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
    execFileSync('pnpm', ['pack', '--pack-destination', companions], {
      cwd: directory,
      stdio: 'pipe',
    });
    tarballs[name] =
      `file:${join(companions, `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)}`;
  }
  const consumer = await mkdtemp(join(tmpdir(), 'vela-graphql-consumer-'));
  const version = async (name, base = root) =>
    JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, base), 'utf8')).version;
  const graphqlRoot = new URL('packages/graphql/', root);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'vela-graphql-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(required.map((name) => [name, tarballs[name]])),
          graphql: await version('graphql', graphqlRoot),
          'graphql-yoga': await version('graphql-yoga', graphqlRoot),
          zod: await version('zod'),
        },
        devDependencies: {
          typescript: await version('typescript'),
          '@cloudflare/workers-types': await version('@cloudflare/workers-types'),
          wrangler: await version('wrangler'),
        },
        overrides: tarballs,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2024',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2024'],
          types: ['@cloudflare/workers-types'],
          strict: true,
          noEmit: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
        },
        include: ['*.ts'],
      },
      null,
      2,
    ),
  );
  await cp(new URL('apps/graphql-worker/src/index.ts', root), join(consumer, 'worker.ts'));
  for (const name of ['graphql-consumer.ts', 'graphql-consumer.mjs']) {
    await cp(new URL(`tests/release/fixtures/${name}`, root), join(consumer, name));
  }
  await writeFile(
    join(consumer, 'wrangler.json'),
    JSON.stringify(
      {
        name: 'vela-graphql-consumer',
        main: 'worker.ts',
        compatibility_date: '2026-09-21',
        vars: { APP_LABEL: 'packed' },
      },
      null,
      2,
    ),
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
  // The example reads APP_LABEL from ENV, typed by the generated Cloudflare.Env.
  run('npx', [
    '--no-install',
    'wrangler',
    'types',
    '--include-runtime=false',
    '--strict-vars=false',
  ]);
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit']);
  run('node', ['graphql-consumer.mjs']);
  run('npx', ['--no-install', 'wrangler', 'deploy', '--dry-run', '--outdir', 'worker-bundle']);
  const yoga = join(consumer, 'node_modules/graphql-yoga');
  await rename(yoga, yoga + '-disabled');
  try {
    run('node', [
      '--input-type=module',
      '-e',
      "await import('@velajs/graphql'); await import('@velajs/graphql/schema');",
    ]);
  } finally {
    await rename(yoga + '-disabled', yoga);
  }
  const archives = Object.fromEntries(
    await Promise.all(
      required.map(async (name) => [
        name,
        'sha512-' +
          createHash('sha512')
            .update(await readFile(tarballs[name].slice(5)))
            .digest('base64'),
      ]),
    ),
  );
  const proof = { path: consumer, status: 'passed', archives };
  await writeFile(join(consumer, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    `PASS: packed GraphQL runtime, declarations, optional Yoga isolation and native Worker bundle: ${consumer}`,
  );
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? '.artifacts/release');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  await verifyGraphqlPackage(
    Object.fromEntries(
      manifest.packages.map((entry) => [entry.name, `file:${join(directory, entry.filename)}`]),
    ),
  );
}
