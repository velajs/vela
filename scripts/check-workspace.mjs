import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertV1Releases } from './release-line.mjs';
import { starterManifest, starterPinMismatches } from './starter-pins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const projects = JSON.parse(
  execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
);
const packages = projects.map((project) => ({
  ...JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8')),
  path: project.path,
}));
const names = new Set(packages.map((pkg) => pkg.name));
assertV1Releases(packages.filter((pkg) => !pkg.private));
const errors = [];
const changesetsVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/@changesets/cli/package.json'), 'utf8'),
).version;
if (!changesetsVersion.startsWith('3.'))
  errors.push('Changesets action v2 requires Changesets CLI v3');
const lockfiles = execFileSync('git', ['ls-files', '*pnpm-lock.yaml'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n');
for (const path of lockfiles) {
  if (path !== 'pnpm-lock.yaml' && existsSync(join(root, path)))
    errors.push(`${path} duplicates the root lockfile`);
}
for (const pkg of packages) {
  const path = relative(root, pkg.path);
  if (!path) continue;
  if (!/^(packages|apps)\/[^/]+$/.test(path))
    errors.push(`${path} is outside the workspace layout`);
  if (path.startsWith('apps/') && !pkg.private)
    errors.push(`${path} must remain a private application`);
  if (!pkg.private && !path.startsWith('packages/'))
    errors.push(`${path} must publish from packages/`);
  if (pkg.devDependencies?.typescript && pkg.devDependencies.typescript !== 'catalog:')
    errors.push(`${path} must use the shared TypeScript 7 catalog`);
  for (const file of [
    '.git',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.changeset',
    '.github/workflows',
  ]) {
    if (existsSync(join(pkg.path, file))) errors.push(`${path}/${file} duplicates root ownership`);
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (names.has(name) && !range.startsWith('workspace:'))
        errors.push(`${pkg.name}: ${field}.${name} must use workspace:`);
      if (/^(file|link):/.test(range))
        errors.push(`${pkg.name}: ${field}.${name} uses a local filesystem range`);
    }
  }
  if (
    !pkg.private &&
    (pkg.repository?.url !== 'git+https://github.com/velajs/vela.git' ||
      pkg.repository?.directory !== path)
  ) {
    errors.push(`${pkg.name}: repository metadata must point to this monorepo directory`);
  }
}
const versions = new Map(packages.map((pkg) => [pkg.name, pkg.version]));
for (const mismatch of starterPinMismatches(
  JSON.parse(readFileSync(starterManifest, 'utf8')),
  versions,
)) {
  errors.push(`packages/cli/templates/worker: ${mismatch}`);
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(
  `Verified one workspace: ${packages.filter((pkg) => !pkg.private).length} public packages, shared lockfile and local dependency ranges.`,
);
