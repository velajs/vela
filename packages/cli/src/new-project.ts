import { lstat, mkdir, open, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from 'clipanion';
import { hasErrorCode } from './project/files.js';

const templates = new URL('../templates/', import.meta.url);

export const TEMPLATES = ['minimal', 'api'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface CreateProjectOptions {
  /** `minimal` (one controller and service, the default) or `api` (a KV, queue and cron API). */
  readonly template?: TemplateName;
  /** The package manager the generated files and instructions use; pnpm by default. */
  readonly packageManager?: PackageManager;
}

/** How the generated README and the `vela new` output spell each command. */
export interface PackageManagerCommands {
  readonly install: string;
  /** Runs a package script: `<run> dev`. */
  readonly run: string;
  /** Runs a dependency's binary: `<exec> wrangler login`. */
  readonly exec: string;
}

export function packageManagerCommands(manager: PackageManager): PackageManagerCommands {
  switch (manager) {
    case 'npm':
      return { install: 'npm install', run: 'npm run', exec: 'npx' };
    case 'yarn':
      return { install: 'yarn install', run: 'yarn run', exec: 'yarn exec' };
    case 'bun':
      return { install: 'bun install', run: 'bun run', exec: 'bunx' };
    default:
      return { install: 'pnpm install', run: 'pnpm run', exec: 'pnpm exec' };
  }
}

/** The package manager a `<pm> dlx`/`npx`/`bunx` invocation ran under, from its user agent. */
export function detectPackageManager(
  userAgent: string | undefined = process.env.npm_config_user_agent,
): PackageManager {
  const name = userAgent?.split('/', 1)[0];
  return PACKAGE_MANAGERS.find((manager) => manager === name) ?? 'pnpm';
}

// Native dependencies the Workers toolchain builds on install.
const NATIVE_BUILDS = ['esbuild', 'workerd'];

/** The files one package manager needs next to the shared manifest. */
function packageManagerFiles(manager: PackageManager): Record<string, string> {
  switch (manager) {
    case 'pnpm':
      return {
        'pnpm-workspace.yaml': `allowBuilds:\n${NATIVE_BUILDS.map((name) => `  ${name}: true\n`).join('')}`,
      };
    case 'yarn':
      // Wrangler, Vite and the Workers pool resolve packages from node_modules.
      return { '.yarnrc.yml': 'nodeLinker: node-modules\n' };
    default:
      return {};
  }
}

function adaptManifest(source: string, manager: PackageManager): string {
  const manifest: Record<string, unknown> = JSON.parse(source);
  if (manager !== 'pnpm') delete manifest.packageManager;
  if (manager === 'bun') manifest.trustedDependencies = NATIVE_BUILDS;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function listFiles(directory: URL): Promise<string[]> {
  const root = fileURLToPath(directory);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .toSorted();
}

/** Every file of `template` (overriding the shared ones), as it is written for `name`. */
export async function renderTemplate(
  name: string,
  { template = 'minimal', packageManager = 'pnpm' }: CreateProjectOptions = {},
): Promise<Map<string, string>> {
  if (!TEMPLATES.includes(template)) {
    throw new UsageError(
      `Unknown template ${JSON.stringify(template)}. Use one of: ${TEMPLATES.join(', ')}.`,
    );
  }
  if (!PACKAGE_MANAGERS.includes(packageManager)) {
    throw new UsageError(
      `Unknown package manager ${JSON.stringify(packageManager)}. Use one of: ${PACKAGE_MANAGERS.join(', ')}.`,
    );
  }
  const commands = packageManagerCommands(packageManager);
  const sources = new Map<string, URL>();
  for (const directory of ['shared/', `${template}/`]) {
    const base = new URL(directory, templates);
    // eslint-disable-next-line no-await-in-loop -- The template overrides the shared files.
    for (const file of await listFiles(base)) sources.set(file, new URL(file, base));
  }
  const files = new Map<string, string>();
  for (const [file, url] of sources) {
    // eslint-disable-next-line no-await-in-loop -- Small files, read in a stable order.
    let content = (await readFile(url, 'utf8'))
      .replaceAll('__PROJECT_NAME__', name)
      .replaceAll('__INSTALL__', commands.install)
      .replaceAll('__RUN__', commands.run)
      .replaceAll('__EXEC__', commands.exec);
    if (file === 'package.json') content = adaptManifest(content, packageManager);
    files.set(file === 'gitignore' ? '.gitignore' : file, content);
  }
  for (const [file, content] of Object.entries(packageManagerFiles(packageManager))) {
    files.set(file, content);
  }
  return files;
}

export function assertProjectName(name: string): void {
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
}

export async function createProject(
  name: string,
  cwd: string,
  options: CreateProjectOptions = {},
): Promise<string> {
  assertProjectName(name);
  // Read the entire packaged template before touching the destination.
  const contents = await renderTemplate(name, options);
  const destination = join(cwd, name);
  const directories: string[] = [];
  const written: string[] = [];
  try {
    try {
      await mkdir(destination);
      directories.push(destination);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
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
    const subdirectories = new Set(
      [...contents.keys()].flatMap((file) => {
        const parts = file.split('/').slice(0, -1);
        return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
      }),
    );
    for (const subdirectory of [...subdirectories].toSorted()) {
      const directory = join(destination, subdirectory);
      // eslint-disable-next-line no-await-in-loop -- Parents first.
      await mkdir(directory);
      directories.push(directory);
    }
    for (const [file, content] of contents) {
      const path = join(destination, file);
      // Never overwrite a file, even if it appeared after the initial check.
      // eslint-disable-next-line no-await-in-loop
      const handle = await open(path, 'wx');
      written.push(path);
      try {
        // eslint-disable-next-line no-await-in-loop
        await writeFile(handle, content, 'utf8');
      } finally {
        // eslint-disable-next-line no-await-in-loop
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
