import { open, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseCron } from '@velajs/vela/schedule';
import { hasErrorCode, isRecord } from '../project/files.js';
import { findWranglerConfig, readWranglerConfig, wranglerMain } from '../project/wrangler.js';
import { names, singular } from './names.js';
import {
  controllerSource,
  cronSource,
  durableObjectHostSource,
  durableObjectSource,
  moduleSource,
  processorSource,
  resourceSources,
  serviceSource,
  type ImportExtension,
} from './schematics.js';
import {
  SourceEditError,
  addExport,
  addToModule,
  callsMethod,
  moduleExport,
  workerRootImport,
  type NamedImport,
} from './source-editor.js';

export const SCHEMATICS = [
  'module',
  'controller',
  'service',
  'resource',
  'queue',
  'cron',
  'durable-object',
] as const;
export type Schematic = (typeof SCHEMATICS)[number];

export interface GenerateOptions {
  readonly schematic: Schematic;
  readonly name: string;
  /** The project directory (the working directory by default). */
  readonly cwd: string;
  /** Where new directories go, relative to `cwd` (default `src`). */
  readonly path?: string;
  /** Write the files into `path` itself instead of a directory named after them. */
  readonly flat?: boolean;
  /** The module to register in, instead of the nearest one. */
  readonly module?: string;
  /** Write the files only; print the registration instead of editing modules. */
  readonly skipImport?: boolean;
  /** `cron`: the Cloudflare cron expression (default `0 * * * *`). */
  readonly schedule?: string;
  /** `queue`: the Wrangler producer binding (default: the name in capitals). */
  readonly binding?: string;
}

/** The files a generation creates and updates, and what to do next. */
export interface GeneratePlan {
  readonly creates: readonly { readonly path: string; readonly content: string }[];
  readonly updates: readonly { readonly path: string; readonly content: string }[];
  /** Lines for people: registrations to make by hand, then follow-up commands. */
  readonly notes: readonly string[];
}

const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** The relative-import ending the project's modules already use. */
function importExtension(source: string | undefined): ImportExtension {
  const specifiers = [...(source ?? '').matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );
  if (specifiers.some((specifier) => specifier.endsWith('.js'))) return '.js';
  if (specifiers.some((specifier) => specifier.endsWith('.ts'))) return '.ts';
  return specifiers.length > 0 ? '' : '.js';
}

/** `from` → `to` as an import specifier with the project's extension. */
function specifier(from: string, to: string, ext: ImportExtension): string {
  const path = relative(dirname(from), to).split(sep).join('/').replace(/\.ts$/, ext);
  return path.startsWith('.') ? path : `./${path}`;
}

async function usesZod(cwd: string): Promise<boolean> {
  const text = await readText(join(cwd, 'package.json'));
  if (text === undefined) return false;
  const manifest: unknown = JSON.parse(text);
  if (!isRecord(manifest)) return false;
  return [manifest.dependencies, manifest.devDependencies].some(
    (dependencies) => isRecord(dependencies) && Object.hasOwn(dependencies, 'zod'),
  );
}

/** The Worker entry: Wrangler's `main`, else `src/worker.ts`. */
async function workerEntry(cwd: string): Promise<string> {
  const { path } = await findWranglerConfig(cwd);
  if (path === undefined) return join(cwd, 'src/worker.ts');
  return wranglerMain(await readWranglerConfig(path));
}

/** Resolve an import specifier of `from` to its TypeScript source. */
function sourceFile(from: string, specifierText: string): string {
  const target = resolve(dirname(from), specifierText);
  return target.endsWith('.ts') ? target : `${target.replace(/\.(?:js|mjs)$/, '')}.ts`;
}

/** The TypeScript source an import specifier of `from` names; `./dir` may name `./dir/index.ts`. */
export async function importedSource(from: string, specifierText: string): Promise<string> {
  const file = sourceFile(from, specifierText);
  if (/\.[cm]?[jt]s$/.test(specifierText) || (await readText(file)) !== undefined) return file;
  const index = join(resolve(dirname(from), specifierText), 'index.ts');
  return (await readText(index)) === undefined ? file : index;
}

/** A `@Module()` class a file exports, found where it is declared. */
export interface ResolvedModule {
  /** The file declaring the class: the one asked for when none on the way does. */
  readonly file: string;
  /** The name `file` exports the class under. */
  readonly name: string;
  readonly source: string;
  /** The files that re-export the class on the way, the one asked for first. */
  readonly via: readonly string[];
}

/**
 * Follow the export `name` of the module file `file` to the file declaring
 * the class, through `export { … } from`, exported imports and `export *`
 * barrels. A file naming no such class stands for itself (its only
 * `@Module()` class, else editing it reports the missing class); a re-export
 * of a file that does not exist throws. Undefined when `file` does not exist.
 */
export async function resolveModuleClass(
  file: string,
  name: string,
): Promise<ResolvedModule | undefined> {
  const via: string[] = [];
  // `strict`: an `export *` source, which counts only when it names the class.
  const visit = async (
    current: string,
    wanted: string,
    strict: boolean,
  ): Promise<ResolvedModule | undefined> => {
    if (via.includes(current)) return undefined;
    const source = await readText(current);
    if (source === undefined) return undefined;
    const here: ResolvedModule = { file: current, name: wanted, source, via: [...via] };
    const found = moduleExport(current, source, wanted);
    if (found.kind === 'declared') return here;
    via.push(current);
    try {
      if (found.kind === 'reexported') {
        const target = await importedSource(current, found.from.from);
        const resolved = await visit(target, found.from.name, false);
        if (resolved !== undefined || strict) return resolved;
        if ((await readText(target)) === undefined) {
          throw new SourceEditError(
            `${current} re-exports ${wanted} from '${found.from.from}', which does not exist.`,
          );
        }
        return here;
      }
      for (const star of found.stars) {
        // eslint-disable-next-line no-await-in-loop -- The first source declaring it wins.
        const resolved = await visit(await importedSource(current, star.from), star.name, true);
        if (resolved !== undefined) return resolved;
      }
      return strict ? undefined : here;
    } finally {
      via.pop();
    }
  };
  return visit(file, name, false);
}

/** The root module: the file, and the class, the Worker entry passes to createCloudflareWorker() or defineCloudflareApp(). */
interface RootModule {
  readonly file: string;
  /** The name the file exports the class under, when the Worker entry names it. */
  readonly name?: string;
  /** The files re-exporting it between the Worker entry and `file`. */
  readonly via: readonly string[];
}

async function rootModule(entry: string, sourceRoot: string): Promise<RootModule | undefined> {
  const text = await readText(entry);
  const root = text === undefined ? undefined : workerRootImport(entry, text);
  if (root) {
    const file = await importedSource(entry, root.from);
    return (await resolveModuleClass(file, root.name)) ?? { file, name: root.name, via: [] };
  }
  const fallback = join(sourceRoot, 'app.module.ts');
  return (await readText(fallback)) === undefined ? undefined : { file: fallback, via: [] };
}

const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/;

/**
 * Whether a source file under `directories`, tests and declaration files
 * aside, calls `QueueModule.forRoot()` or `forRootAsync()`: the application
 * configures its queue driver once, in any module.
 */
export async function configuresQueueDriver(directories: readonly string[]): Promise<boolean> {
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        // eslint-disable-next-line no-await-in-loop -- Stops at the first match.
        if (await visit(path)) return true;
        continue;
      }
      const source =
        entry.isFile() &&
        SOURCE_FILE.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        !TEST_FILE.test(entry.name) &&
        !seen.has(path);
      if (!source) continue;
      seen.add(path);
      // eslint-disable-next-line no-await-in-loop -- Stops at the first match.
      const text = await readFile(path, 'utf8');
      if (!/QueueModule\s*\.\s*forRoot/.test(text)) continue;
      try {
        if (callsMethod(path, text, 'QueueModule', ['forRoot', 'forRootAsync'])) return true;
      } catch (error) {
        // A file that does not parse may still configure it: do not add a second one.
        if (error instanceof SourceEditError) return true;
        throw error;
      }
    }
    return false;
  };
  for (const directory of new Set(directories)) {
    // eslint-disable-next-line no-await-in-loop -- Stops at the first match.
    if (await visit(directory)) return true;
  }
  return false;
}

/**
 * The module a file in `directory` belongs to: the `*.module.ts` of that
 * directory (preferring one named after it), else of each parent up to the
 * source root, else the root module.
 */
async function nearestModule(
  directory: string,
  sourceRoot: string,
  root: string | undefined,
  exclude: string,
): Promise<string> {
  for (let current = directory; ; current = dirname(current)) {
    let entries: string[] = [];
    try {
      // eslint-disable-next-line no-await-in-loop -- Walks one directory at a time.
      entries = await readdir(current);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    const modules = entries
      .filter((file) => file.endsWith('.module.ts'))
      .map((file) => join(current, file))
      .filter((file) => file !== exclude);
    const named = modules.find((file) => basename(file) === `${basename(current)}.module.ts`);
    if (named) return named;
    if (root && modules.includes(root)) return root;
    if (modules.length === 1 && modules[0]) return modules[0];
    if (modules.length > 1) {
      throw new Error(
        `${relative(sourceRoot, current) || '.'} has several modules (${modules.map((file) => basename(file)).join(', ')}); choose one with --module.`,
      );
    }
    if (relative(sourceRoot, current).startsWith('..') || current === sourceRoot) break;
  }
  if (root) return root;
  throw new Error('No module found to register in; pass --module <file> or use --skip-import.');
}

interface Registration {
  readonly key: 'imports' | 'controllers' | 'providers';
  readonly entry: string;
  readonly imports: readonly NamedImport[];
  /** Skip when an element of the host module matches (a forRoot already configured). */
  readonly unless?: RegExp;
  /** Register in the root module rather than the nearest one. */
  readonly root?: boolean;
}

/**
 * Plan a generation: the files to create and the module (or Worker entry)
 * edits that register them. Nothing is written.
 */
export async function planGeneration(options: GenerateOptions): Promise<GeneratePlan> {
  const cwd = resolve(options.cwd);
  const name = names(options.name);
  const sourceRoot = resolve(cwd, options.path ?? 'src');
  const directory = options.flat ? sourceRoot : join(sourceRoot, name.kebab);
  const entry = await workerEntry(cwd);
  const root = await rootModule(entry, sourceRoot);
  const ext = importExtension(root === undefined ? undefined : await readText(root.file));
  const creates: { path: string; content: string }[] = [];
  const registrations: Registration[] = [];
  const notes: string[] = [];
  let target = '';
  let exported: { name: string; file: string } | undefined;
  const file = (suffix: string) => join(directory, `${name.kebab}.${suffix}`);

  switch (options.schematic) {
    case 'module': {
      target = file('module.ts');
      creates.push({ path: target, content: moduleSource(name) });
      registrations.push(register('imports', `${name.pascal}Module`, target));
      break;
    }
    case 'controller':
      target = file('controller.ts');
      creates.push({ path: target, content: controllerSource(name) });
      registrations.push(register('controllers', `${name.pascal}Controller`, target));
      break;
    case 'service':
      target = file('service.ts');
      creates.push({ path: target, content: serviceSource(name) });
      registrations.push(register('providers', `${name.pascal}Service`, target));
      break;
    case 'resource': {
      const sources = resourceSources(name, singular(name), ext, await usesZod(cwd));
      for (const [relativePath, content] of Object.entries(sources)) {
        creates.push({ path: join(directory, relativePath), content });
      }
      target = file('module.ts');
      registrations.push(register('imports', `${name.pascal}Module`, target));
      break;
    }
    case 'cron': {
      const schedule = options.schedule ?? '0 * * * *';
      if (
        !/^[A-Za-z0-9*/,#? -]+$/.test(schedule) ||
        !parseCron(schedule, { dialect: 'cloudflare', timeZone: 'UTC' })
      ) {
        throw new Error(
          `--schedule ${JSON.stringify(schedule)} is not a Cloudflare cron expression.`,
        );
      }
      target = file('cron.ts');
      creates.push({ path: target, content: cronSource(name, schedule) });
      registrations.push(register('providers', `${name.pascal}Cron`, target));
      notes.push(`Next: vela cf sync --write adds the ${JSON.stringify(schedule)} cron trigger.`);
      break;
    }
    case 'queue': {
      const binding = options.binding ?? name.constant;
      if (!BINDING.test(binding))
        throw new Error(`--binding ${JSON.stringify(binding)} is not a binding name.`);
      target = file('processor.ts');
      creates.push({ path: target, content: processorSource(name) });
      const constant = `${name.constant}_QUEUE`;
      registrations.push(
        {
          key: 'imports',
          entry: `QueueModule.registerQueue({ name: ${constant}, binding: '${binding}' })`,
          imports: [
            { name: 'QueueModule', from: '@velajs/vela/queue' },
            { name: constant, from: target },
          ],
        },
        register('providers', `${name.pascal}Processor`, target),
      );
      // The driver is configured once, in whichever module already does it.
      if (!(await configuresQueueDriver([dirname(entry), sourceRoot]))) {
        registrations.push({
          key: 'imports',
          entry: 'QueueModule.forRoot({ driver: cloudflareQueues() })',
          imports: [
            { name: 'QueueModule', from: '@velajs/vela/queue' },
            { name: 'cloudflareQueues', from: '@velajs/cloudflare/queues' },
          ],
          unless: /^QueueModule\.forRoot(?:Async)?\(/,
          root: true,
        });
      }
      notes.push(
        `Next: vela cf sync --write adds the ${binding} producer and its consumer, and your types script types ENV.${binding}.`,
      );
      break;
    }
    case 'durable-object': {
      if (root?.name === undefined) {
        throw new Error(
          'A Durable Object boots the application from its root module, but the Worker entry ' +
            'names none: pass the root module to createCloudflareWorker() or ' +
            'defineCloudflareApp() in the Worker entry.',
        );
      }
      const hostFile = file('host.ts');
      target = file('durable-object.ts');
      const rootFrom = specifier(target, root.file, ext);
      const rootName = root.name === 'default' ? 'AppModule' : root.name;
      const rootImport =
        root.name === 'default'
          ? `import ${rootName} from '${rootFrom}';`
          : `import { ${rootName} } from '${rootFrom}';`;
      creates.push(
        { path: hostFile, content: durableObjectHostSource(name) },
        {
          path: target,
          content: durableObjectSource(
            name,
            rootName,
            rootImport,
            specifier(target, hostFile, ext),
          ),
        },
      );
      exported = { name: name.pascal, file: target };
      notes.push(
        `Next: vela cf sync --write adds the ${name.constant} binding and a migration, and your types script types ENV.${name.constant}.`,
      );
      break;
    }
  }

  const updates = new Map<string, string>();
  const read = async (path: string): Promise<string> => {
    const current = updates.get(path) ?? (await readText(path));
    if (current === undefined) throw new Error(`${relative(cwd, path)} does not exist.`);
    return current;
  };
  const display = (path: string) => relative(cwd, path).split(sep).join('/');
  // With --skip-import: what to register by hand, listed before the next steps.
  const manual: string[] = [];

  if (exported) {
    const from = specifier(entry, exported.file, ext);
    if (options.skipImport) {
      manual.push(
        `Export it from the Worker entry ${display(entry)}: export { ${exported.name} } from '${from}';`,
      );
    } else {
      const edit = addExport(entry, await read(entry), exported.name, from);
      if (edit.changed) updates.set(entry, edit.source);
    }
  }

  if (registrations.length > 0) {
    const explicit = options.module === undefined ? undefined : resolve(cwd, options.module);
    // A new module registers in the module of the directory above its own.
    const start =
      (options.schematic === 'module' || options.schematic === 'resource') && !options.flat
        ? dirname(directory)
        : directory;
    const found = explicit ?? (await nearestModule(start, sourceRoot, root?.file, target));
    // A file re-exporting the root module stands for the file declaring it.
    const parent = root?.via.includes(found) ? root.file : found;
    for (const registration of registrations) {
      const host = registration.root ? (root?.file ?? parent) : parent;
      const imports = registration.imports.map((named) =>
        isAbsolute(named.from)
          ? { name: named.name, from: specifier(host, named.from, ext) }
          : named,
      );
      if (options.skipImport) {
        const lines = imports.map((named) => `import { ${named.name} } from '${named.from}';`);
        manual.push(
          `Register it in ${display(host)}: add ${registration.entry} to @Module({ ${registration.key} })` +
            (lines.length > 0 ? ` after ${lines.join(' ')}` : '.'),
        );
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- Edits of one file build on each other.
      const edit = addToModule(host, await read(host), registration.key, registration.entry, {
        imports,
        unless: registration.unless,
        module: host === root?.file ? root.name : undefined,
      });
      if (edit.changed) updates.set(host, edit.source);
    }
  }

  return {
    creates,
    updates: [...updates].map(([path, content]) => ({ path, content })),
    notes: [...manual, ...notes],
  };
}

/** Register the class `entry`, imported from the new file `from`. */
function register(key: Registration['key'], entry: string, from: string): Registration {
  return { key, entry, imports: [{ name: entry, from }] };
}

/**
 * Write a plan: create every new file without overwriting one that exists,
 * then apply the edits. Nothing is written when any new file exists already.
 */
export async function writeGeneration(plan: GeneratePlan): Promise<void> {
  for (const { path } of plan.creates) {
    // eslint-disable-next-line no-await-in-loop -- Check every target before writing any.
    if ((await readText(path)) !== undefined) throw new Error(`${path} already exists.`);
  }
  for (const { path, content } of plan.creates) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(dirname(path), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    const handle = await open(path, 'wx');
    try {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(handle, content, 'utf8');
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await handle.close();
    }
  }
  for (const { path, content } of plan.updates) {
    // eslint-disable-next-line no-await-in-loop
    await writeFile(path, content, 'utf8');
  }
}
