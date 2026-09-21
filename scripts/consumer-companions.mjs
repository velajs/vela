import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);

/** Pack consumer-only companions without changing the publication manifest. */
export async function ensureConsumerArchives(releaseTarballs, required) {
  const tarballs = { ...releaseTarballs };
  const companions = [];
  const directory = await mkdtemp(join(tmpdir(), 'vela-consumer-companions-'));
  const projects = JSON.parse(
    execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const paths = new Map(projects.map((project) => [project.name, project.path]));
  const pending = [...Object.keys(tarballs), ...required];
  const visited = new Set();
  while (pending.length > 0) {
    const name = pending.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    const path = paths.get(name);
    if (!path) throw new Error(`Unknown consumer companion: ${name}`);
    if (!tarballs[name]) {
      const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      if (manifest.private) throw new Error(`Cannot pack private consumer companion: ${name}`);
      execFileSync('pnpm', ['exec', 'publint'], { cwd: path, stdio: 'pipe' });
      execFileSync('pnpm', ['pack', '--pack-destination', directory], {
        cwd: path,
        stdio: 'pipe',
      });
      const filename = `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
      const archive = join(directory, filename);
      tarballs[name] = `file:${archive}`;
      companions.push({
        name,
        version: manifest.version,
        path: archive,
        integrity: `sha512-${createHash('sha512')
          .update(await readFile(archive))
          .digest('base64')}`,
      });
    }
    // Follow the packed manifest, including optional framework peers. This
    // prevents npm from silently fetching older framework dependencies.
    const packed = JSON.parse(
      execFileSync('tar', ['-xOf', tarballs[name].slice('file:'.length), 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, range] of Object.entries(packed[field] ?? {})) {
        if (/^(workspace|catalog|link|file):/.test(range)) {
          throw new Error(`Unresolved archive dependency: ${name} -> ${dependency}@${range}`);
        }
        if (paths.has(dependency)) pending.push(dependency);
      }
    }
  }
  return { tarballs, companions };
}
