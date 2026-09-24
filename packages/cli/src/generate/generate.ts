import { open, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseCron } from '@velajs/vela/schedule';
import { hasErrorCode, isRecord } from '../project/files.js';
import { findWranglerConfig, readWranglerConfig, wranglerMain } from '../project/wrangler.js';
import { names, singular } from './names.js';
import {
  controllerSource,
  cronSource,
  durableObjectSource,
  moduleSource,
  processorSource,
  resourceSources,
  serviceSource,
  type ImportExtension,
} from './schematics.js';
import { addExport, addToModule, workerRootImport, type NamedImport } from './source-editor.js';

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

/** The root module file: what the Worker entry passes to createCloudflareWorker(). */
async function rootModuleFile(cwd: string, sourceRoot: string): Promise<string | undefined> {
  const entry = await workerEntry(cwd);
  const text = await readText(entry);
  const root = text === undefined ? undefined : workerRootImport(entry, text);
  if (root) return sourceFile(entry, root.from);
  const fallback = join(sourceRoot, 'app.module.ts');
  return (await readText(fallback)) === undefined ? undefined : fallback;
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
  /** Skip when an element matches (a forRoot already configured). */
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
  const root = await rootModuleFile(cwd, sourceRoot);
  const ext = importExtension(root === undefined ? undefined : await readText(root));
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
        {
          key: 'imports',
          entry: 'QueueModule.forRoot({ driver: cloudflareQueues() })',
          imports: [
            { name: 'QueueModule', from: '@velajs/vela/queue' },
            { name: 'cloudflareQueues', from: '@velajs/cloudflare/queues' },
          ],
          unless: /^QueueModule\.forRoot(?:Async)?\(/,
          root: true,
        },
      );
      notes.push(
        `Next: vela cf sync --write adds the ${binding} producer and its consumer, and your types script types ENV.${binding}.`,
      );
      break;
    }
    case 'durable-object': {
      target = file('durable-object.ts');
      creates.push({ path: target, content: durableObjectSource(name) });
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
    const entry = await workerEntry(cwd);
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
    const parent = explicit ?? (await nearestModule(start, sourceRoot, root, target));
    for (const registration of registrations) {
      const host = registration.root ? (root ?? parent) : parent;
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
