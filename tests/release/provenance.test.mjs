import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { releaseMaterials, preserveReleaseProvenance } from '../../scripts/release-provenance.mjs';

test('attestation materials reject tampered archives and unrelated consumer proofs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vela-provenance-test-'));
  const bytes = Buffer.from('tested archive');
  const hash = (value) => `sha512-${createHash('sha512').update(value).digest('base64')}`;
  const manifest = JSON.stringify({
    packages: [
      { name: '@velajs/test', version: '1.0.0', filename: 'test.tgz', integrity: hash(bytes) },
    ],
  });
  const proof = { status: 'passed', manifestIntegrity: hash(manifest) };
  try {
    await writeFile(join(directory, 'manifest.json'), manifest);
    await writeFile(join(directory, 'consumer.json'), JSON.stringify(proof));
    await writeFile(join(directory, 'test.tgz'), bytes);
    const [material] = await releaseMaterials(directory);
    assert.equal(material.digest, createHash('sha512').update(bytes).digest('hex'));
    await writeFile(join(directory, 'test.tgz'), 'changed archive');
    await assert.rejects(releaseMaterials(directory), /Changed archive/);
    await writeFile(
      join(directory, 'consumer.json'),
      JSON.stringify({ ...proof, manifestIntegrity: 'unrelated' }),
    );
    await assert.rejects(releaseMaterials(directory), /matching consumer proof/);
    await writeFile(
      join(directory, 'consumer.json'),
      JSON.stringify({ ...proof, status: 'failed' }),
    );
    await assert.rejects(releaseMaterials(directory), /matching consumer proof/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local and PR jobs cannot generate release provenance', async () => {
  // PR/main verification jobs lack the release job's id-token permission.
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
    await assert.rejects(
      preserveReleaseProvenance('/unused'),
      /main-branch GitHub release workflow/,
    );
});
