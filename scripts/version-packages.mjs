import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
execFileSync('pnpm', ['exec', 'changeset', 'version'], { cwd: root, stdio: 'inherit' });
execFileSync('node', ['packages/vela/scripts/sync-skill-version.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
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
