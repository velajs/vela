import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);

/** Verify workflow's public subpaths using only installed archives outside the workspace. */
export async function verifyWorkflowPackage(tarballs) {
  if (!tarballs['@velajs/workflow']) throw new Error('A workflow archive is required');
  const consumer = await mkdtemp(join(tmpdir(), 'vela-workflow-consumer-'));
  const version = async (name) =>
    JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), 'utf8')).version;
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'vela-workflow-archive-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@velajs/workflow': tarballs['@velajs/workflow'],
          zod: await version('zod'),
        },
        devDependencies: {
          typescript: await version('typescript'),
          '@types/node': await version('@types/node'),
        },
        overrides: tarballs,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          verbatimModuleSyntax: true,
          types: ['node'],
        },
        include: ['*.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  await cp(new URL('apps/workflow-lab/src/main.ts', root), join(consumer, 'example.ts'));
  await cp(
    new URL('tests/release/fixtures/workflow-consumer.ts', root),
    join(consumer, 'contract.ts'),
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
  run('node', ['example.ts']);
  run('node', ['contract.ts']);
  console.log(
    `PASS: workflow root and /harness archive imports, Zod 4 types and replay: ${consumer}`,
  );
  return consumer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const artifactDir = resolve(process.argv[2] ?? '.artifacts/release');
  const artifacts = JSON.parse(await readFile(join(artifactDir, 'manifest.json'), 'utf8'));
  await verifyWorkflowPackage(
    Object.fromEntries(
      artifacts.packages.map((entry) => [entry.name, `file:${join(artifactDir, entry.filename)}`]),
    ),
  );
}
