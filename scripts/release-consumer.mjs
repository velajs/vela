import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyAiPackage } from './ai-consumer.mjs';
import { verifyNewProject } from './cli-consumer.mjs';
import { verifyWorkflowPackage } from './workflow-consumer.mjs';

const root = new URL('../', import.meta.url);
const artifactDir = resolve(process.argv[2] ?? '.artifacts/release');
const artifacts = JSON.parse(await readFile(join(artifactDir, 'manifest.json'), 'utf8'));
const tarballs = Object.fromEntries(
  artifacts.packages.map((entry) => [entry.name, `file:${join(artifactDir, entry.filename)}`]),
);
const sample = new URL('apps/api-starter/', root);
const consumer = await mkdtemp(join(tmpdir(), 'vela-release-consumer-'));
for (const file of [
  'src',
  'web',
  'scripts',
  '.swcrc',
  'tsconfig.json',
  'tsconfig.web.json',
  'wrangler.jsonc',
  'migrations',
]) {
  await cp(new URL(file, sample), join(consumer, file), { recursive: true });
}
const manifest = JSON.parse(await readFile(new URL('package.json', sample), 'utf8'));
const installed = JSON.parse(
  execFileSync('pnpm', ['--filter', manifest.name, 'list', '--depth', '0', '--json'], {
    cwd: sample,
    encoding: 'utf8',
  }),
).find((entry) => entry.name === manifest.name);
if (!installed) throw new Error('Install the workspace before checking a release consumer');
const workspaceVersions = Object.fromEntries(
  JSON.parse(
    execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ).map((entry) => [entry.name, entry.version]),
);
for (const field of ['dependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (name in tarballs) manifest[field][name] = tarballs[name];
    else if (range.startsWith('workspace:')) {
      if (!workspaceVersions[name]) throw new Error(`Missing workspace version: ${name}`);
      manifest[field][name] = workspaceVersions[name];
    } else if (range.startsWith('catalog:')) manifest[field][name] = installed[field][name].version;
  }
}
manifest.overrides = tarballs;
await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Consumer: ${consumer}`);
// Fresh install outside every workspace, using only tarballs and registry packages.
const run = (command, args) => execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });
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
run('npm', ['run', 'client:check']);
run('npx', ['--no-install', 'wrangler', 'deploy', '--dry-run', '--outdir', 'worker-bundle']);
const generatedProject = tarballs['@velajs/cli']
  ? await verifyNewProject(join(consumer, 'node_modules/@velajs/cli/dist/index.js'))
  : undefined;
const aiPackage = tarballs['@velajs/ai']
  ? await verifyAiPackage(tarballs['@velajs/ai'].slice('file:'.length))
  : undefined;
const workflowConsumer = tarballs['@velajs/workflow']
  ? await verifyWorkflowPackage(tarballs)
  : undefined;
await writeFile(
  join(artifactDir, 'consumer.json'),
  JSON.stringify(
    {
      path: consumer,
      status: 'passed',
      generatedProject,
      aiPackage,

      workflowConsumer,
      manifestIntegrity: `sha512-${createHash('sha512')
        .update(await readFile(join(artifactDir, 'manifest.json')))
        .digest('base64')}`,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'PASS: clean packed-package consumer install, build, types, generated client and Worker bundle',
);
