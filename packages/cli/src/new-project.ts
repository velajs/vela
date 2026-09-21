import { lstat, mkdir, open, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from 'clipanion';

const template = new URL('../templates/worker/', import.meta.url);
const files = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  '.swcrc',
  'wrangler.jsonc',
  'vela.config.mjs',
  'gitignore',
  'README.md',
  'src/worker.ts',
  'src/app.module.ts',
  'src/app.controller.ts',
  'src/app.service.ts',
] as const;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function createProject(name: string, cwd: string): Promise<string> {
  if (
    name.length > 63 ||
    name !== name.trim() ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name)
  ) {
    throw new UsageError(
      'Use a project name of at most 63 lowercase letters, digits, and single hyphens, starting with a letter. Paths and reserved device names are not supported.',
    );
  }

  // Read the entire packaged template before touching the destination.
  const contents = await Promise.all(
    files.map(async (file) => ({
      file: file === 'gitignore' ? '.gitignore' : file,
      content: (await readFile(new URL(file, template), 'utf8')).replaceAll(
        '__PROJECT_NAME__',
        name,
      ),
    })),
  );
  const destination = join(cwd, name);
  const directories: string[] = [];
  const written: string[] = [];
  try {
    try {
      await mkdir(destination);
      directories.push(destination);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const stat = await lstat(destination);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new UsageError(`Destination is not a regular directory: ${destination}`);
      }
      if ((await readdir(destination)).length) {
        throw new UsageError(
          `Destination is not empty: ${destination}. Choose a new project name.`,
        );
      }
    }
    const source = join(destination, 'src');
    await mkdir(source);
    directories.push(source);
    for (const { file, content } of contents) {
      const path = join(destination, file);
      // Never overwrite a file, even if it appeared after the initial check.
      const handle = await open(path, 'wx');
      written.push(path);
      try {
        await writeFile(handle, content, 'utf8');
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    // Only undo our own writes; rmdir leaves directories containing other files intact.
    for (const path of written.toReversed()) await unlink(path).catch(() => {});
    for (const path of directories.toReversed()) await rmdir(path).catch(() => {});
    throw error;
  }
  return destination;
}
