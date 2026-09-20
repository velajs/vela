import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publishRelease, registryIntegrity } from './release-publish.mjs';

const plan = JSON.parse(await readFile('release-plan.json', 'utf8'));
const output = process.env.CHANGESETS_OUTPUT;
if (output) await writeFile(output, '');
const missing = plan.packages.filter((entry) => registryIntegrity(entry) === undefined);
// Reconcile a run interrupted after npm accepted every package but before the
// action created all GitHub releases. Do not turn a registry success into a
// silent skip of the remaining release work.
const unreleased = plan.packages.filter((entry) => {
  const tag = encodeURIComponent(`${entry.name}@${entry.version}`);
  try {
    execFileSync('gh', ['api', `repos/velajs/vela/releases/tags/${tag}`], { stdio: 'pipe' });
    return false;
  } catch (error) {
    if (String(error.stderr).includes('(HTTP 404)')) return true;
    throw error;
  }
});
if (!missing.length && !unreleased.length) {
  console.log('Every version in the release plan has an npm and GitHub release.');
  process.exit(0);
}
const directory = resolve('.artifacts/release');
const run = (args) => execFileSync('node', args, { stdio: 'inherit' });
run(['scripts/release-pack.mjs', directory]);
run(['scripts/release-consumer.mjs', directory]);
await publishRelease(directory, { oidc: true });
// Changesets action v2 consumes these events to push tags and create releases.
const events = [];
for (const entry of unreleased) {
  const tag = `${entry.name}@${entry.version}`;
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { stdio: 'pipe' });
  } catch {
    execFileSync('git', ['tag', '-a', tag, '-m', tag], { stdio: 'inherit' });
  }
  events.push({ type: 'git-tag', tag, packageName: entry.name });
}
if (output) await writeFile(output, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
