import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRecoveryRun,
  validateRecoveryPlan,
  validateArtifactEntries,
  reconcileReleases,
} from '../../scripts/release-resume.mjs';
import { validateProvenanceSource } from '../../scripts/release-provenance.mjs';

const sha = 'a'.repeat(40);
const source = { sha, runId: '123' };
const entry = {
  name: '@velajs/example',
  path: 'packages/example',
  version: '1.2.3',
  filename: 'velajs-example-1.2.3.tgz',
};
const plan = { packages: [entry] };
const run = {
  id: 123,
  repository: { full_name: 'velajs/vela' },
  head_repository: { full_name: 'velajs/vela' },
  head_sha: sha,
  head_branch: 'main',
  path: '.github/workflows/release.yml',
  event: 'push',
  status: 'completed',
};

test('recovery admits only completed main release runs from this repository', () => {
  assert.deepEqual(validateRecoveryRun(run, '123'), source);
  for (const change of [
    { id: 456 },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { path: '.github/workflows/ci.yml' },
    { head_repository: { full_name: 'other/vela' } },
    { head_sha: '../HEAD' },
  ])
    assert.throws(() => validateRecoveryRun({ ...run, ...change }, '123'), /completed main/);
  assert.throws(() => validateRecoveryRun(run, '123/attempts/1'), /completed main/);
});

test('recovery rejects unrelated plans and limits historical recovery to metadata', () => {
  validateRecoveryPlan(plan, plan, plan, false);
  const later = { packages: [{ ...entry, version: '1.3.0' }] };
  assert.throws(() => validateRecoveryPlan(plan, later, plan, false), /source release plan/);
  assert.throws(() => validateRecoveryPlan(plan, plan, later, false), /Superseded/);
  validateRecoveryPlan(plan, plan, later, true);
  assert.throws(
    () => validateRecoveryPlan({ packages: [entry, entry] }, plan, plan, true),
    /Duplicate/,
  );
  assert.throws(
    () =>
      validateRecoveryPlan(
        { packages: [{ ...entry, filename: '../archive.tgz' }] },
        plan,
        plan,
        true,
      ),
    /filename/,
  );
  for (const names of [
    [],
    ['../archive.tgz'],
    ['/archive.tgz'],
    ['directory/archive.tgz'],
    ['same', 'same'],
    ['file\nname'],
  ])
    assert.throws(() => validateArtifactEntries(names), /unique, flat/);
  validateArtifactEntries([
    'manifest.json',
    'consumer.json',
    'velajs-example-1.2.3.tgz.sigstore.json',
  ]);
});

test('provenance must identify the original workflow, commit and run', () => {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/velajs/vela',
            path: '.github/workflows/release.yml',
            ref: 'refs/heads/main',
          },
        },
        resolvedDependencies: [
          { uri: 'git+https://github.com/velajs/vela@refs/heads/main', digest: { gitCommit: sha } },
        ],
      },
      runDetails: {
        metadata: { invocationId: 'https://github.com/velajs/vela/actions/runs/123/attempts/1' },
      },
    },
  };
  validateProvenanceSource(statement, source);
  assert.throws(
    () => validateProvenanceSource(statement, { ...source, sha: 'b'.repeat(40) }),
    /original main/,
  );
  assert.throws(
    () => validateProvenanceSource(statement, { ...source, runId: '456' }),
    /original main/,
  );
  const other = structuredClone(statement);
  other.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/pull/1/merge';
  assert.throws(() => validateProvenanceSource(other, source), /original main/);
});

test('reconciliation creates bot metadata at the preserved source, never the recovery head', async () => {
  const writes = [];
  await reconcileReleases([entry], source, {
    readSource: (commit, path) => {
      assert.equal(commit, sha);
      assert.equal(path, 'packages/example/CHANGELOG.md');
      return '## 1.2.3\n\nFixed delivery.\n\n## 1.2.2\nOld notes';
    },
    github: async (path, body) => {
      if (!body) return undefined;
      writes.push({ path, body });
      return path === 'git/tags'
        ? { sha: 'tag-object' }
        : {
            author: { login: 'github-actions[bot]' },
            html_url: 'https://github.com/velajs/vela/releases/example',
          };
    },
  });
  assert.equal(writes[0].body.object, sha);
  assert.deepEqual(writes[1].body, { ref: 'refs/tags/@velajs/example@1.2.3', sha: 'tag-object' });
  assert.equal(writes[2].body.target_commitish, sha);
  assert.equal(writes[2].body.make_latest, 'false');
  assert.match(writes[2].body.body, /Fixed delivery/);
  assert.doesNotMatch(writes[2].body.body, /Old notes/);
});

test('existing metadata is idempotent and conflicting tags block all writes', async () => {
  let writes = 0;
  const github = async (path, body) => {
    if (body) writes++;
    if (path.startsWith('git/ref/')) return { object: { type: 'tag', sha: 'tag-object' } };
    if (path === 'git/tags/tag-object') return { object: { type: 'commit', sha } };
    if (path.startsWith('releases/tags/'))
      return { tag_name: '@velajs/example@1.2.3', draft: false, prerelease: false };
  };
  await reconcileReleases([entry], source, { github });
  assert.equal(writes, 0);
  await assert.rejects(
    reconcileReleases([entry], source, {
      github: (path, body) =>
        path.startsWith('git/ref/')
          ? { object: { type: 'commit', sha: 'b'.repeat(40) } }
          : github(path, body),
    }),
    /Tag source mismatch/,
  );
  assert.equal(writes, 0);
});

test('metadata preflight performs no writes when tags and releases are absent', async () => {
  await reconcileReleases([entry], source, {
    dryRun: true,
    readSource: () => '## 1.2.3\n\nRelease notes',
    github: (_path, body) => {
      assert.equal(body, undefined);
      return undefined;
    },
  });
});
