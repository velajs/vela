import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

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
  const npmRoot = join(
    execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim(),
    'npm',
  );
  const require = createRequire(join(npmRoot, 'package.json'));
  if (require(join(npmRoot, 'package.json')).version !== '11.19.0')
    throw new Error('Revalidate the provenance integration before changing pinned npm');
  const npa = require('npm-package-arg');
  const { generateProvenance, verifyProvenance } = require(
    join(npmRoot, 'node_modules/libnpmpublish/lib/provenance.js'),
  );
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
