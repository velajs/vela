import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const sha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export function publicationOrder(entries) {
  const pending = new Map(entries.map((entry) => [entry.name, entry]));
  if (pending.size !== entries.length) throw new Error('Duplicate package in release manifest');
  const order = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(
      (entry) => !entry.dependencies.some((name) => pending.has(name)),
    );
    if (!ready.length) throw new Error('Package dependency cycle in release plan');
    for (const entry of ready) {
      pending.delete(entry.name);
      order.push(entry);
    }
  }
  return order;
}

export async function waitForIntegrity(
  entry,
  readIntegrity,
  { attempts = 60, pause = () => delay(10_000) } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const existing = await readIntegrity(entry);
    if (existing === entry.integrity) return;
    if (existing !== undefined)
      throw new Error(`Registry collision: ${entry.name}@${entry.version}`);
    if (attempt + 1 < attempts) await pause();
  }
  throw new Error(
    `npm is still processing ${entry.name}@${entry.version}; retain these artifacts and retry later`,
  );
}

const npmEnv = () => ({
  ...process.env,
  npm_config_cache: resolve('.cache/npm'),
  npm_config_progress: 'false',
});
/** npm treats even an explicit provenance=false as conflicting with a file.
 * A signed bundle is verified by npm; remove only automatic-generation config. */
export const provenanceFileEnvironment = (environment = process.env) =>
  Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'npm_config_provenance'),
  );
const npm = (args) => execFileSync('npm', args, { encoding: 'utf8', env: npmEnv() });
export function registryIntegrity(entry) {
  try {
    return JSON.parse(
      npm([
        'view',
        `${entry.name}@${entry.version}`,
        'dist.integrity',
        '--json',
        '--prefer-online',
      ]),
    );
  } catch (error) {
    let body;
    try {
      body = JSON.parse(String(error.stdout));
    } catch {
      throw error;
    }
    if (body.error?.code === 'E404') return undefined;
    throw error;
  }
}

export async function publishRelease(directory, { dryRun = false, oidc = false } = {}) {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const manifestIntegrity = sha512(manifestBytes);
  const consumer = JSON.parse(await readFile(join(directory, 'consumer.json'), 'utf8'));
  if (consumer.status !== 'passed' || consumer.manifestIntegrity !== manifestIntegrity) {
    throw new Error('These exact artifacts have not passed release-consumer.mjs');
  }
  const entries = [];
  for (const entry of manifest.packages) {
    if (entry.filename !== entry.filename.split(/[\\/]/).at(-1))
      throw new Error('Invalid archive filename');
    const tarball = join(directory, entry.filename);
    if (sha512(await readFile(tarball)) !== entry.integrity)
      throw new Error(`Changed archive: ${entry.filename}`);
    const packed = JSON.parse(
      execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    if (packed.name !== entry.name || packed.version !== entry.version || packed.private)
      throw new Error(`Invalid archive: ${entry.filename}`);
    entries.push({
      ...entry,
      tarball,
      dependencies: Object.keys({
        ...packed.dependencies,
        ...packed.optionalDependencies,
        ...packed.peerDependencies,
      }),
    });
  }
  const order = publicationOrder(entries);
  if (dryRun) {
    console.log(order.map((entry) => `${entry.name}@${entry.version}`).join('\n'));
    console.log('PASS: verified artifacts and dependency order; nothing published');
    return;
  }
  if (oidc) {
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_REPOSITORY !== 'velajs/vela' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    ) {
      throw new Error(
        'OIDC publication requires the velajs/vela main-branch GitHub release workflow',
      );
    }
  } else npm(['whoami']);
  const journalPath = join(directory, 'publication.json');
  let journal = { manifestIntegrity, accepted: {} };
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (journal.manifestIntegrity !== manifestIntegrity)
    throw new Error('Publication journal belongs to different artifacts');
  const save = async () => {
    await writeFile(`${journalPath}.tmp`, JSON.stringify(journal, null, 2) + '\n');
    await rename(`${journalPath}.tmp`, journalPath);
  };
  // Check the entire set before making any registry mutation.
  for (const entry of order) {
    const existing = registryIntegrity(entry);
    if (existing !== undefined && existing !== entry.integrity)
      throw new Error(`Registry collision: ${entry.name}@${entry.version}`);
  }
  for (const entry of order) {
    if (registryIntegrity(entry) === undefined && !journal.accepted[entry.name]) {
      const provenanceFile = `${entry.tarball}.sigstore.json`;
      // npm verifies the signed bundle's subject and digest before submitting it.
      // Recovery must reuse actual CI provenance, never assert a local build was CI.
      await readFile(provenanceFile);
      try {
        // OIDC authorizes publish, not dist-tag updates. Publish stable CI releases
        // directly to latest; interactive coordinated releases use next first.
        execFileSync(
          'npm',
          [
            'publish',
            entry.tarball,
            '--access',
            'public',
            '--tag',
            oidc ? 'latest' : 'next',
            '--provenance-file',
            provenanceFile,
          ],
          {
            env: provenanceFileEnvironment(npmEnv()),
            stdio: oidc ? ['inherit', 'pipe', 'pipe'] : 'inherit',
          },
        );
      } catch (error) {
        // A prior process can die after npm accepts the archive but before our
        // journal is saved. An existing staged version must still match our hash.
        if (!String(error.stderr).includes('previously staged version')) throw error;
      }
      journal.accepted[entry.name] = entry.integrity;
      await save();
    }
    await waitForIntegrity(entry, registryIntegrity);
    console.log(`Verified ${entry.name}@${entry.version}`);
  }
  if (!oidc) {
    for (const entry of order) {
      const latest = JSON.parse(
        npm(['view', entry.name, 'dist-tags.latest', '--json', '--prefer-online']),
      );
      if (latest !== entry.version)
        execFileSync('npm', ['dist-tag', 'add', `${entry.name}@${entry.version}`, 'latest'], {
          env: npmEnv(),
          stdio: 'inherit',
        });
    }
  }
  for (const entry of order) {
    const latest = JSON.parse(
      npm(['view', entry.name, 'dist-tags.latest', '--json', '--prefer-online']),
    );
    if (latest !== entry.version) throw new Error(`Latest tag mismatch: ${entry.name}`);
    console.log(`Released ${entry.name}@${entry.version}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(
    process.argv.slice(2).find((value) => !value.startsWith('--')) ?? '.artifacts/release',
  );
  await publishRelease(directory, {
    dryRun: process.argv.includes('--dry-run'),
    oidc: process.argv.includes('--oidc'),
  });
}
