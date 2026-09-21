import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Install and exercise the exact event-source archive, even though api-starter does not use it. */
export async function verifyEventSourcePackage(archive, integrity) {
  const actual = `sha512-${createHash('sha512')
    .update(await readFile(archive))
    .digest('base64')}`;
  if (actual !== integrity)
    throw new Error('Event-source archive integrity does not match the release manifest');
  const consumer = await mkdtemp(join(tmpdir(), 'vela-event-source-consumer-'));
  const root = new URL('../', import.meta.url);
  const typescript = JSON.parse(
    await readFile(new URL('node_modules/typescript/package.json', root), 'utf8'),
  );
  const sample = new URL('apps/event-sourcing-inventory/', root);
  await cp(new URL('src', sample), join(consumer, 'src'), { recursive: true });
  await cp(new URL('tsconfig.json', sample), join(consumer, 'tsconfig.json'));
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'event-source-packed-consumer',
        private: true,
        type: 'module',
        dependencies: { '@velajs/event-source': `file:${archive}` },
        devDependencies: { typescript: typescript.version },
      },
      null,
      2,
    ) + '\n',
  );
  const run = (command, args) => execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    join(consumer, '.npm-cache'),
  ]);
  const manifest = JSON.parse(
    await readFile(join(consumer, 'node_modules/@velajs/event-source/package.json'), 'utf8'),
  );
  if (
    Object.keys(manifest.dependencies ?? {}).length ||
    Object.keys(manifest.peerDependencies ?? {}).length
  ) {
    throw new Error(
      'Event-source must remain independently installable without runtime dependencies or peers',
    );
  }
  // A new subpath must gain explicit consumer coverage rather than silently passing.
  if (JSON.stringify(Object.keys(manifest.exports)) !== '["."]') {
    throw new Error('Update event-source consumer checks to cover its new public subpaths');
  }
  await cp(
    new URL('tests/release/fixtures/event-source.ts', root),
    join(consumer, 'src/public-api.ts'),
  );
  run('npx', ['--no-install', 'tsc', '--noEmit']);
  run('node', ['src/public-api.ts']);
  run('node', ['src/index.ts']);
  return { path: consumer, status: 'passed', exports: ['.'], integrity: actual };
}
