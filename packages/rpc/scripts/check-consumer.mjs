/* eslint-disable no-console -- Verification command output. */
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'vela-rpc-consumer-'));
try {
  // Copy, never symlink: resolution must not fall back into the workspace.
  const installed = join(directory, 'node_modules/@velajs/rpc');
  await mkdir(installed, { recursive: true });
  await cp(join(root, 'dist'), join(installed, 'dist'), { recursive: true });
  await cp(join(root, 'package.json'), join(installed, 'package.json'));
  await cp(join(root, 'fixtures/browser-consumer.ts'), join(directory, 'consumer.ts'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2024', 'DOM'],
        types: [],
        strict: true,
        skipLibCheck: false,
        outDir: './output',
      },
      files: ['consumer.ts'],
    }),
  );
  const typescript = JSON.parse(await readFile(require.resolve('typescript/package.json'), 'utf8'));
  const tsc = fileURLToPath(
    new URL(typescript.bin.tsc, import.meta.resolve('typescript/package.json')),
  );
  execFileSync(process.execPath, [tsc, '-p', join(directory, 'tsconfig.json')], {
    cwd: directory,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [join(directory, 'output/consumer.js')], {
    cwd: directory,
    stdio: 'inherit',
  });
  const manifest = JSON.parse(await readFile(require.resolve('tsdown/package.json'), 'utf8'));
  const cli = fileURLToPath(
    new URL(manifest.bin.tsdown, import.meta.resolve('tsdown/package.json')),
  );
  execFileSync(
    process.execPath,
    [
      cli,
      'consumer.ts',
      '--platform',
      'browser',
      '--format',
      'esm',
      '--no-dts',
      '--out-dir',
      'browser',
    ],
    { cwd: directory, stdio: 'inherit' },
  );
  console.log('Browser bundle and declarations passed with only @velajs/rpc installed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
