import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

function npmProvenance() {
  const npmRoot = join(
    execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim(),
    'npm',
  );
  const require = createRequire(join(npmRoot, 'package.json'));
  if (require(join(npmRoot, 'package.json')).version !== '11.19.0')
    throw new Error('Revalidate the provenance integration before changing pinned npm');
  return {
    npa: require('npm-package-arg'),
    ...require(join(npmRoot, 'node_modules/libnpmpublish/lib/provenance.js')),
  };
}

export function validateProvenanceSource(statement, { sha, runId }) {
  const definition = statement?.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const invocation = statement?.predicate?.runDetails?.metadata?.invocationId;
  if (
    statement?._type !== 'https://in-toto.io/Statement/v1' ||
    statement?.predicateType !== 'https://slsa.dev/provenance/v1' ||
    workflow?.repository !== 'https://github.com/velajs/vela' ||
    workflow?.path !== '.github/workflows/release.yml' ||
    workflow?.ref !== 'refs/heads/main' ||
    !definition?.resolvedDependencies?.some(
      (dependency) =>
        dependency.uri === 'git+https://github.com/velajs/vela@refs/heads/main' &&
        dependency.digest?.gitCommit === sha,
    ) ||
    typeof invocation !== 'string' ||
    !new RegExp(
      `^https://github\\.com/velajs/vela/actions/runs/${runId}/attempts/[1-9][0-9]*$`,
    ).test(invocation)
  )
    throw new Error('Provenance does not belong to the original main release run');
}

/** Verify saved signatures and source identity without generating replacement attestations. */
export async function verifyReleaseProvenance(directory, source) {
  const materials = await releaseMaterials(directory);
  const { npa, verifyProvenance } = npmProvenance();
  for (const entry of materials) {
    const file = `${entry.tarball}.sigstore.json`;
    const bundle = JSON.parse(await readFile(file, 'utf8'));
    await verifyProvenance(
      {
        name: npa.toPurl(npa.resolve(entry.name, entry.version)),
        digest: { sha512: entry.digest },
      },
      file,
    );
    validateProvenanceSource(
      JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')),
      source,
    );
  }
}

export async function releaseMaterials(directory) {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const consumer = JSON.parse(await readFile(join(directory, 'consumer.json'), 'utf8'));
  if (consumer.status !== 'passed' || consumer.manifestIntegrity !== integrity(manifestBytes))
    throw new Error('Cannot attest archives without a matching consumer proof');
  return Promise.all(
    manifest.packages.map(async (entry) => {
      if (entry.filename !== entry.filename.split(/[\\/]/).at(-1))
        throw new Error('Invalid archive filename');
      const tarball = join(directory, entry.filename);
      const bytes = await readFile(tarball);
      if (integrity(bytes) !== entry.integrity)
        throw new Error(`Changed archive: ${entry.filename}`);
      return { ...entry, tarball, digest: createHash('sha512').update(bytes).digest('hex') };
    }),
  );
}

/** Preserve npm's signed CI provenance even when first-time package auth fails.
 * The recovery publisher can attach these verified bundles without claiming a local CI build. */
export async function preserveReleaseProvenance(directory) {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'velajs/vela' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  )
    throw new Error('Release provenance requires the main-branch GitHub release workflow');
  const materials = await releaseMaterials(directory);
  // release.yml pins npm. Use its own SLSA generator and verifier rather than
  // maintaining a second interpretation of npm's provenance format.
  const { npa, generateProvenance, verifyProvenance } = npmProvenance();
  for (const entry of materials) {
    const subject = {
      name: npa.toPurl(npa.resolve(entry.name, entry.version)),
      digest: { sha512: entry.digest },
    };
    const file = `${entry.tarball}.sigstore.json`;
    await writeFile(file, JSON.stringify(await generateProvenance([subject], {})) + '\n', {
      flag: 'wx',
    });
    await verifyProvenance(subject, file);
    console.log(`Preserved signed provenance: ${entry.name}@${entry.version}`);
  }
}
