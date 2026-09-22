import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishRelease, registryIntegrity } from './release-publish.mjs';
import { verifyReleaseProvenance } from './release-provenance.mjs';

const repository = 'velajs/vela';
function api(path, body) {
  try {
    return JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          `repos/${repository}/${path}`,
          ...(body ? ['--method', 'POST', '--input', '-'] : []),
        ],
        {
          encoding: 'utf8',
          ...(body ? { input: JSON.stringify(body) } : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ),
    );
  } catch (error) {
    if (!body && String(error.stderr).includes('(HTTP 404)')) return undefined;
    throw error;
  }
}
const sourceFile = (sha, path) =>
  execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf8' });

export function validateRecoveryRun(run, runId) {
  if (
    !/^[1-9][0-9]*$/.test(String(runId)) ||
    String(run?.id) !== String(runId) ||
    run?.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.head_branch !== 'main' ||
    run.path !== '.github/workflows/release.yml' ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.status !== 'completed' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  )
    throw new Error(
      'Recovery requires a completed main-branch release workflow from this repository',
    );
  return { sha: run.head_sha, runId: String(runId) };
}

export function validateRecoveryPlan(manifest, sourcePlan, currentPlan, metadataOnly) {
  const identity = (plan) => {
    if (!Array.isArray(plan?.packages) || plan.packages.length === 0)
      throw new Error('Empty release plan');
    const values = plan.packages.map(({ name, version, path }) => {
      if (
        typeof name !== 'string' ||
        !/^@velajs\/[a-z0-9-]+$/.test(name) ||
        typeof version !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(version) ||
        typeof path !== 'string' ||
        !/^packages\/[a-z0-9-]+$/.test(path)
      )
        throw new Error('Invalid release identity');
      return JSON.stringify([name, version, path]);
    });
    if (new Set(plan.packages.map((entry) => entry.name)).size !== values.length)
      throw new Error('Duplicate release package');
    return values.toSorted().join('\n');
  };
  if (identity(manifest) !== identity(sourcePlan))
    throw new Error('Artifact manifest differs from its source release plan');
  if (!metadataOnly && identity(manifest) !== identity(currentPlan))
    throw new Error('Superseded release: use metadata-only recovery to avoid changing latest');
  for (const entry of manifest.packages)
    if (entry.filename !== `${entry.name.replace('@', '').replace('/', '-')}-${entry.version}.tgz`)
      throw new Error('Unexpected archive filename');
}

export function validateArtifactEntries(names) {
  if (
    !names.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || name.includes('..'))
  )
    throw new Error('Recovery artifacts must contain unique, flat regular files');
}

export function releaseNotes(changelog, entry, source) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line === `## ${entry.version}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const notes =
    start < 0
      ? entry.summary
      : lines
          .slice(start + 1, end < 0 ? undefined : end)
          .join('\n')
          .trim();
  return `${notes || `Release ${entry.version}.`}\n\nSource: [${source.sha.slice(0, 7)}](https://github.com/${repository}/commit/${source.sha}). Verified archives: [original workflow](https://github.com/${repository}/actions/runs/${source.runId}).\n`;
}

/** Reconcile only absent metadata; existing tags must resolve to the original source. */
export async function reconcileReleases(
  entries,
  source,
  { github = api, readSource = sourceFile, dryRun = false } = {},
) {
  const pending = [];
  for (const entry of entries) {
    const tag = `${entry.name}@${entry.version}`;
    const ref = await github(`git/ref/tags/${tag}`);
    let object = ref?.object;
    for (let depth = 0; object?.type === 'tag' && depth < 8; depth++)
      object = (await github(`git/tags/${object.sha}`))?.object;
    if (ref && (object?.type !== 'commit' || object.sha !== source.sha))
      throw new Error(`Tag source mismatch: ${tag}`);
    const release = await github(`releases/tags/${encodeURIComponent(tag)}`);
    if (release && (!ref || release.tag_name !== tag || release.draft || release.prerelease))
      throw new Error(`Existing release metadata mismatch: ${tag}`);
    if (!release)
      pending.push({
        entry,
        tag,
        ref,
        notes: releaseNotes(
          await readSource(source.sha, `${entry.path}/CHANGELOG.md`),
          entry,
          source,
        ),
      });
  }
  if (dryRun) return;
  for (const { entry, tag, ref, notes } of pending) {
    if (!ref) {
      const object = await github('git/tags', {
        tag,
        message: tag,
        object: source.sha,
        type: 'commit',
      });
      await github('git/refs', { ref: `refs/tags/${tag}`, sha: object.sha });
    }
    const created = await github('releases', {
      tag_name: tag,
      target_commitish: source.sha,
      name: tag,
      body: notes,
      draft: false,
      prerelease: false,
      make_latest: 'false',
    });
    if (created.author?.login !== 'github-actions[bot]')
      throw new Error(`Unexpected release author: ${entry.name}`);
    console.log(`Reconciled ${tag}: ${created.html_url}`);
  }
}

export async function resumeRelease() {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  )
    throw new Error('Release recovery requires the main-branch GitHub workflow');
  const runId = process.env.RECOVERY_RUN_ID;
  if (!/^[1-9][0-9]*$/.test(runId ?? '')) throw new Error('Invalid recovery run ID');
  const metadataOnly = process.env.RECOVERY_METADATA_ONLY === 'true';
  const source = validateRecoveryRun(api(`actions/runs/${runId}`), runId);
  execFileSync('git', ['merge-base', '--is-ancestor', source.sha, 'HEAD']);
  const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`).artifacts.filter(
    (artifact) => artifact.name === `release-${source.sha}` && !artifact.expired,
  );
  if (artifacts.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(artifacts[0].digest ?? ''))
    throw new Error('Expected one retained, digest-identified release artifact');
  const directory = resolve('.artifacts/release');
  await mkdir(resolve('.artifacts'), { recursive: true });
  await mkdir(directory); // Never overwrite a retained journal or archive set.
  const zip = execFileSync(
    'gh',
    ['api', `repos/${repository}/actions/artifacts/${artifacts[0].id}/zip`],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  if (
    `sha256-${createHash('sha256').update(zip).digest('hex')}` !==
    artifacts[0].digest.replace(':', '-')
  )
    throw new Error('Downloaded artifact digest mismatch');
  const zipPath = resolve('.artifacts/recovery.zip');
  await writeFile(zipPath, zip, { flag: 'wx' });
  const names = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
  validateArtifactEntries(names);
  execFileSync('unzip', ['-q', zipPath, '-d', directory]);
  for (const name of await readdir(directory))
    if (!(await lstat(join(directory, name))).isFile())
      throw new Error('Artifact contains a non-regular file');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  validateRecoveryPlan(
    manifest,
    JSON.parse(sourceFile(source.sha, 'release-plan.json')),
    JSON.parse(await readFile('release-plan.json', 'utf8')),
    metadataOnly,
  );
  await publishRelease(directory, { dryRun: true });
  await verifyReleaseProvenance(directory, source);
  await writeFile(
    join(directory, 'recovery.json'),
    JSON.stringify({ ...source, metadataOnly, recoveryRunId: process.env.GITHUB_RUN_ID }, null, 2) +
      '\n',
  );
  if (!metadataOnly) {
    await reconcileReleases(manifest.packages, source, { dryRun: true });
    await publishRelease(directory, { oidc: true });
  }
  for (const entry of manifest.packages)
    if (registryIntegrity(entry) !== entry.integrity)
      throw new Error(`Published integrity mismatch: ${entry.name}@${entry.version}`);
  // GITHUB_TOKEN gives the original-source tags and missing releases bot authorship.
  await reconcileReleases(manifest.packages, source);
  console.log(
    'PASS: original archives and source verified; release metadata reconciled without repacking',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await resumeRelease();
