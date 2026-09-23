import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertV1Releases } from './release-line.mjs';
import { starterManifest, syncStarterPins } from './starter-pins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (
  !readdirSync(join(root, '.changeset')).some(
    (name) => name.endsWith('.md') && name !== 'README.md',
  )
) {
  console.log('No pending changesets; the existing release plan is unchanged.');
  process.exit(0);
}
const projects = JSON.parse(
  execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
);
const before = projects.map((project) => ({
  path: project.path,
  manifest: JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8')),
}));
const publicPackages = before.filter(({ manifest }) => !manifest.private);
assertV1Releases(publicPackages.map(({ manifest }) => manifest));
const publicNames = new Set(publicPackages.map(({ manifest }) => manifest.name));
const temporary = mkdtempSync(join(tmpdir(), 'vela-release-plan-'));
try {
  const status = join(temporary, 'status.json');
  execFileSync('pnpm', ['exec', 'changeset', 'status', '--output', status], {
    cwd: root,
    stdio: 'inherit',
  });
  const plan = JSON.parse(readFileSync(status, 'utf8'));
  assertV1Releases(
    plan.releases
      .filter(({ name }) => publicNames.has(name))
      .map(({ name, newVersion }) => ({ name, version: newVersion })),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
execFileSync('pnpm', ['exec', 'changeset', 'version'], { cwd: root, stdio: 'inherit' });
execFileSync('node', ['packages/vela/scripts/sync-skill-version.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
const versions = new Map(
  before.map(({ path }) => {
    const next = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    return [next.name, next.version];
  }),
);
const starter = JSON.parse(readFileSync(starterManifest, 'utf8'));
writeFileSync(starterManifest, JSON.stringify(syncStarterPins(starter, versions), null, 2) + '\n');
const changed = before.flatMap(({ path, manifest }) => {
  const next = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  if (next.private || next.version === manifest.version) return [];
  return [
    {
      name: next.name,
      path: relative(root, path),
      version: next.version,
      summary: `See ${relative(root, path)}/CHANGELOG.md.`,
    },
  ];
});
if (changed.length) {
  execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });
  const versions = new Set(changed.map((entry) => entry.version));
  const version = versions.size === 1 ? changed[0].version : new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(root, 'release-plan.json'),
    JSON.stringify({ version, packages: changed }, null, 2) + '\n',
  );
  console.log(`Prepared a release plan for ${changed.length} changed packages.`);
} else {
  console.log('No package versions changed; the existing release plan is unchanged.');
}
