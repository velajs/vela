import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? '.modernization/release-artifacts');
const manifestBytes = await readFile(join(directory, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const sha512 = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const consumer = JSON.parse(await readFile(join(directory, 'consumer.json'), 'utf8'));
if (consumer.status !== 'passed' || consumer.manifestIntegrity !== sha512(manifestBytes)) {
  throw new Error('These exact artifacts have not passed release-consumer.mjs');
}
const npm = args => execFileSync('npm', [...args, '--cache', resolve('.modernization/npm-cache')], { encoding: 'utf8' });
const pending = new Map();
for (const entry of manifest.packages) {
  const tarball = join(directory, entry.filename);
  if (sha512(await readFile(tarball)) !== entry.integrity) throw new Error(`Changed archive: ${entry.filename}`);
  const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  if (packed.name !== entry.name || packed.version !== entry.version || packed.private) throw new Error(`Invalid archive: ${entry.filename}`);
  pending.set(entry.name, { ...entry, tarball, dependencies: Object.keys({ ...packed.dependencies, ...packed.optionalDependencies, ...packed.peerDependencies }) });
}
const order = [];
while (pending.size) {
  const ready = [...pending.values()].filter(entry => !entry.dependencies.some(name => pending.has(name)));
  if (!ready.length) throw new Error('Package dependency cycle in release plan');
  for (const entry of ready) { pending.delete(entry.name); order.push(entry); }
}
if (process.argv.includes('--dry-run')) {
  console.log(order.map(entry => `${entry.name}@${entry.version}`).join('\n'));
  console.log('PASS: verified artifacts and dependency order; nothing published');
  process.exit(0);
}
npm(['whoami']);
function registryIntegrity(entry) {
  try { return JSON.parse(npm(['view', `${entry.name}@${entry.version}`, 'dist.integrity', '--json'])); }
  catch (error) {
    let body;
    try { body = JSON.parse(String(error.stdout)); } catch { throw error; }
    if (body.error?.code === 'E404') return undefined;
    throw error;
  }
}
// Check every version collision before publishing anything.
for (const entry of order) {
  const existing = registryIntegrity(entry);
  if (existing !== undefined && existing !== entry.integrity) throw new Error(`Registry collision: ${entry.name}@${entry.version}`);
}
for (const entry of order) {
  if (registryIntegrity(entry) === undefined) {
    execFileSync('npm', ['publish', entry.tarball, '--access', 'public', '--tag', 'next', '--cache', resolve('.modernization/npm-cache')], { stdio: 'inherit' });
  }
  if (registryIntegrity(entry) !== entry.integrity) throw new Error(`Published integrity mismatch: ${entry.name}`);
  console.log(`Verified ${entry.name}@${entry.version}`);
}
for (const entry of order) {
  npm(['dist-tag', 'add', `${entry.name}@${entry.version}`, 'latest']);
  const latest = JSON.parse(npm(['view', entry.name, 'dist-tags.latest', '--json']));
  if (latest !== entry.version) throw new Error(`Latest tag mismatch: ${entry.name}`);
  console.log(`Released ${entry.name}@${entry.version}`);
}
