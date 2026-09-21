/* eslint-disable no-console -- Verification command output. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const required = ['@velajs/rpc', '@velajs/vela', '@velajs/errors', '@velajs/live-protocol'];

/** Exercise exact RPC/framework archives outside the workspace, then remove the optional peer. */
export async function verifyRpcPackage(tarballs) {
  for (const name of required) {
    if (!tarballs[name]) throw new Error(`RPC consumer requires a packed ${name} archive`);
  }
  const consumer = await mkdtemp(join(tmpdir(), 'vela-rpc-packed-consumer-'));
  const version = async (name) =>
    JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), 'utf8')).version;
  const [typescript, tsdown, zod] = await Promise.all(['typescript', 'tsdown', 'zod'].map(version));
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'vela-rpc-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(required.map((name) => [name, tarballs[name]])),
          zod,
        },
        devDependencies: { typescript, tsdown },
        overrides: tarballs,
      },
      null,
      2,
    ),
  );
  await cp(
    new URL('packages/rpc/fixtures/browser-consumer.ts', root),
    join(consumer, 'browser-consumer.ts'),
  );
  await cp(
    new URL('packages/rpc/fixtures/server-consumer.ts', root),
    join(consumer, 'server-consumer.ts'),
  );
  const compilerOptions = {
    target: 'ES2024',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    skipLibCheck: true,
    types: [],
    lib: ['ES2024', 'DOM'],
    experimentalDecorators: true,
    outDir: 'output',
  };
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({ compilerOptions, files: ['server-consumer.ts'] }),
  );
  await writeFile(
    join(consumer, 'tsconfig.browser.json'),
    JSON.stringify({
      compilerOptions: { ...compilerOptions, skipLibCheck: false },
      files: ['browser-consumer.ts'],
    }),
  );
  await writeFile(
    join(consumer, 'tsdown.config.mjs'),
    `export default {
    entry: ['browser-consumer.ts'], platform: 'browser', format: ['esm'],
    dts: false, outDir: 'browser', deps: { alwaysBundle: ['@velajs/rpc'] },
  };`,
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
  run('npx', ['--no-install', 'tsc', '-p', 'tsconfig.json']);
  run('node', ['output/server-consumer.js']);
  const framework = join(consumer, 'node_modules/@velajs/vela');
  await rename(framework, `${framework}-disabled`);
  try {
    run('npx', ['--no-install', 'tsc', '-p', 'tsconfig.browser.json']);
    run('node', ['output/browser-consumer.js']);
    run('npx', ['--no-install', 'tsdown', '--config', 'tsdown.config.mjs']);
    const bundle = await readFile(join(consumer, 'browser/browser-consumer.js'), 'utf8');
    if (/(?:from\s*|import\s*\(\s*|import\s*)['"](?![./])/.test(bundle))
      throw new Error('Portable bundle retains external imports');
  } finally {
    await rename(`${framework}-disabled`, framework);
  }
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
  const proof = { path: consumer, status: 'passed', archives };
  await writeFile(join(consumer, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(
    'PASS: packed RPC methods, async schema contracts, request lifetime, optional peer and browser types/bundle',
  );
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? '.artifacts/release');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  await verifyRpcPackage(
    Object.fromEntries(
      manifest.packages.map((entry) => [entry.name, `file:${join(directory, entry.filename)}`]),
    ),
  );
}
