import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The newest modification time of the CLI sources under `directory`, tests aside. */
function newestSource(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/**
 * Vitest global setup: build `dist/` once, before any test file runs, when it
 * is missing or older than the sources. The subprocess tests run the built
 * CLI, and a build started by one test file would replace `dist/` under the
 * others running beside it.
 */
export default function buildCli(): void {
  const entry = join(packageDir, 'dist/index.js');
  if (existsSync(entry) && statSync(entry).mtimeMs >= newestSource(join(packageDir, 'src'))) {
    return;
  }
  execFileSync('pnpm', ['build'], { cwd: packageDir, stdio: 'inherit' });
}
