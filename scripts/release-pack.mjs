import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = new URL('../', import.meta.url);
const plan = JSON.parse(await readFile(new URL('release-plan.json', root), 'utf8'));
const destination = resolve(process.argv[2] ?? '.modernization/release-artifacts');
try {
  await access(resolve(destination, 'manifest.json'));
  throw new Error(
    'Release artifacts already exist in this directory; preserve them and choose a fresh destination',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(destination, { recursive: true });
const artifacts = [];
for (const entry of plan.packages) {
  const source = new URL(`${entry.path}/package.json`, root);
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  if (manifest.private || manifest.version !== entry.version || manifest.name !== entry.name) {
    throw new Error(`Release plan mismatch: ${entry.path}`);
  }
  execFileSync('pnpm', ['exec', 'publint'], {
    cwd: new URL(`${entry.path}/`, root),
    stdio: 'pipe',
  });
  execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: new URL(`${entry.path}/`, root),
    stdio: 'pipe',
  });
  const filename = `${entry.name.replace('@', '').replace('/', '-')}-${entry.version}.tgz`;
  const tarball = resolve(destination, filename);
  const packed = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(packed[field] ?? {})) {
      if (/^(workspace|catalog|link|file):/.test(range))
        throw new Error(`Unresolved ${field}: ${entry.name} -> ${name}@${range}`);
    }
  }
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(tarball))
    .digest('base64')}`;
  artifacts.push({ ...entry, filename, integrity });
  console.log(`${entry.name}@${entry.version}: packed`);
}
await writeFile(
  resolve(destination, 'manifest.json'),
  JSON.stringify({ version: plan.version, packages: artifacts }, null, 2) + '\n',
);
