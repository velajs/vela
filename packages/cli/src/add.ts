import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { applyCloudflareSync, kebabCase, type SyncChange } from './cf-sync.js';
import { configuresQueueDriver, importedSource, resolveModuleClass } from './generate/generate.js';
import {
  SourceEditError,
  addDeclaration,
  addToModule,
  workerRootImport,
  type NamedImport,
} from './generate/source-editor.js';
import { hasErrorCode, isRecord } from './project/files.js';
import {
  environmentSection,
  findWranglerConfig,
  readWranglerConfig,
  wranglerMain,
  wranglerWorkerName,
  type WranglerConfig,
} from './project/wrangler.js';

export const RESOURCES = ['d1', 'kv', 'r2', 'queue'] as const;
export type Resource = (typeof RESOURCES)[number];

const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The native type DI hands out for each bound resource. */
const TYPES: Record<Exclude<Resource, 'queue'>, string> = {
  d1: 'D1Database',
  kv: 'KVNamespace',
  r2: 'R2Bucket',
};

export interface AddOptions {
  readonly resource: Resource;
  readonly binding: string;
  readonly cwd: string;
  /** The Cloudflare resource name (default `<worker>-<binding>`). */
  readonly name?: string;
  readonly config?: string;
  readonly environment?: string;
  /** Do not edit modules; report the registration instead. */
  readonly skipImport?: boolean;
  /** Where messages go. */
  readonly log: (line: string) => void;
}

/** Every binding name the selected environment declares. */
function declaredBindings(config: WranglerConfig, environment: string | undefined): Set<string> {
  const section = environmentSection(config, environment);
  const names = new Set<string>(isRecord(section.vars) ? Object.keys(section.vars) : []);
  const rows = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
  for (const key of [
    'kv_namespaces',
    'd1_databases',
    'r2_buckets',
    'services',
    'hyperdrive',
    'vectorize',
    'workflows',
    'analytics_engine_datasets',
  ]) {
    for (const row of rows(section[key]))
      if (typeof row.binding === 'string') names.add(row.binding);
  }
  const queues = isRecord(section.queues) ? section.queues : {};
  for (const row of rows(queues.producers))
    if (typeof row.binding === 'string') names.add(row.binding);
  const durable = isRecord(section.durable_objects) ? section.durable_objects : {};
  for (const row of rows(durable.bindings)) if (typeof row.name === 'string') names.add(row.name);
  return names;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

/** The package manager the project installs with: its lockfile, else `packageManager`. */
async function projectPackageManager(project: string): Promise<string> {
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- First lockfile wins.
    if (await exists(join(project, file))) return manager;
  }
  try {
    const manifest: unknown = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    const declared = isRecord(manifest) ? manifest.packageManager : undefined;
    if (typeof declared === 'string') return declared.split('@', 1)[0] ?? 'pnpm';
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  return 'pnpm';
}

/** Run the project's own Wrangler, attached to the terminal. */
function wrangler(project: string, args: readonly string[]): void {
  let bin: string;
  try {
    const require = createRequire(join(project, 'package.json'));
    const manifestPath = require.resolve('wrangler/package.json');
    const manifest: unknown = require(manifestPath);
    const entry = isRecord(manifest) && isRecord(manifest.bin) ? manifest.bin.wrangler : undefined;
    if (typeof entry !== 'string') throw new Error('wrangler declares no binary');
    bin = resolve(dirname(manifestPath), entry);
  } catch (cause) {
    throw new Error("vela add runs the project's Wrangler: install wrangler as a dev dependency.", {
      cause,
    });
  }
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: project,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `wrangler ${args.join(' ')} failed${result.status === null ? '' : ` (exit ${result.status})`}.`,
      { cause: result.error },
    );
  }
}

/**
 * Regenerate worker-configuration.d.ts: the project's types script, else
 * `wrangler types`. `config` is a Wrangler file other than the default one,
 * which the script does not read.
 */
async function refreshTypes(
  project: string,
  config: string | undefined,
  log: (line: string) => void,
): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
  const configArgs = config === undefined ? [] : ['--config', config];
  if (typeof scripts.types !== 'string') {
    try {
      wrangler(project, ['types', '--include-runtime=false', ...configArgs]);
    } catch {
      log('Warning: wrangler types failed; run it yourself to type the new binding.');
    }
    return;
  }
  if (config !== undefined) {
    const file = relative(project, config).split(sep).join('/');
    log(
      `The types script reads the default Wrangler file; type the binding from ${file} yourself, ` +
        `for example with wrangler types --include-runtime=false --config ${file}.`,
    );
    return;
  }
  const manager = await projectPackageManager(project);
  const result = spawnSync(manager, ['run', 'types'], {
    cwd: project,
    stdio: ['inherit', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    log(`Warning: ${manager} run types failed; run it yourself to type the new binding.`);
  }
}

/**
 * The root module: the file declaring the class the Worker entry passes to
 * createCloudflareWorker() (through the files re-exporting it), the name that
 * file exports it under, and its source.
 */
async function rootModule(entry: string): Promise<NamedImport & { readonly source: string }> {
  const root = workerRootImport(entry, await readFile(entry, 'utf8'));
  if (!root) {
    throw new Error(
      `${entry} does not export createCloudflareWorker(AppModule); register the binding yourself or pass --skip-import.`,
    );
  }
  const resolved = await resolveModuleClass(await importedSource(entry, root.from), root.name);
  if (resolved === undefined) {
    throw new Error(
      `${entry} imports its root module from ${root.from}, which does not exist; register the binding yourself or pass --skip-import.`,
    );
  }
  return { name: resolved.name, from: resolved.file, source: resolved.source };
}

function importSpecifier(from: string, to: string, like: string): string {
  const ext = /from\s+['"]\.{1,2}\/[^'"]+\.ts['"]/.test(like)
    ? '.ts'
    : /from\s+['"]\.{1,2}\/[^'"]+\.js['"]/.test(like) || !/from\s+['"]\.{1,2}\//.test(like)
      ? '.js'
      : '';
  const path = relative(dirname(from), to).split(sep).join('/').replace(/\.ts$/, ext);
  return path.startsWith('.') ? path : `./${path}`;
}

const BINDINGS_MODULE = (
  binding: string,
  type: string,
) => `import { ENV, Global, InjectionToken, Module, defineProvider } from '@velajs/vela';

/** Wrangler bindings as injection tokens: \`constructor(@Inject(${binding}) value: ${type})\`. */
export const ${binding} = new InjectionToken<${type}>('${binding}');

// Global: every module injects the bindings without importing this module.
@Global()
@Module({
  providers: [defineProvider(${binding}, { useFactory: (env) => env.${binding}, inject: [ENV] })],
  exports: [${binding}],
})
export class BindingsModule {}
`;

/** The files a registration writes and what to tell people, planned before anything is created. */
interface RegistrationPlan {
  readonly writes: readonly { readonly path: string; readonly content: string }[];
  readonly notes: readonly string[];
}

/**
 * Plan the registration of `binding` on the current sources: every module
 * edit runs here, so a module the CLI cannot edit (computed `@Module()`
 * metadata or a spread that may set the list, a root re-exported from a file
 * that does not exist, a bindings module that does not parse) fails before
 * Wrangler creates anything.
 */
async function planRegistration(
  resource: Resource,
  binding: string,
  root: (NamedImport & { readonly source: string }) | undefined,
  entry: string,
  cwd: string,
): Promise<RegistrationPlan> {
  const writes: { path: string; content: string }[] = [];
  const notes: string[] = [];
  if (resource === 'queue') {
    const queueName = kebabCase(binding).replace(/-queue$/, '') || kebabCase(binding);
    const registration = `QueueModule.registerQueue({ name: '${queueName}', binding: '${binding}' })`;
    // The driver is configured once, in whichever module already does it.
    const driver = await configuresQueueDriver([dirname(entry)]);
    if (!root) {
      notes.push(
        `Register it in the root module: ${driver ? '' : 'QueueModule.forRoot({ driver: cloudflareQueues() }) (once) and '}${registration}.`,
      );
    } else {
      const withDriver = driver
        ? { source: root.source, changed: false }
        : addToModule(
            root.from,
            root.source,
            'imports',
            'QueueModule.forRoot({ driver: cloudflareQueues() })',
            {
              imports: [
                { name: 'QueueModule', from: '@velajs/vela/queue' },
                { name: 'cloudflareQueues', from: '@velajs/cloudflare/queues' },
              ],
              unless: /^QueueModule\.forRoot(?:Async)?\(/,
              module: root.name,
            },
          );
      const registered = addToModule(root.from, withDriver.source, 'imports', registration, {
        imports: [{ name: 'QueueModule', from: '@velajs/vela/queue' }],
        module: root.name,
      });
      if (registered.changed || withDriver.changed) {
        writes.push({ path: root.from, content: registered.source });
      }
    }
    notes.push(
      `Inject its client with @InjectQueue('${queueName}') client: QueueClient, and process its jobs with @Processor('${queueName}').`,
    );
    return { writes, notes };
  }

  const type = TYPES[resource];
  if (!root) {
    notes.push(
      `Provide it yourself: export const ${binding} = new InjectionToken<${type}>('${binding}'), ` +
        `provided by defineProvider(${binding}, { useFactory: (env) => env.${binding}, inject: [ENV] }).`,
    );
    return { writes, notes };
  }
  const bindingsFile = join(dirname(root.from), 'bindings.module.ts');
  let current: string | undefined;
  try {
    current = await readFile(bindingsFile, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  if (current === undefined) {
    writes.push({ path: bindingsFile, content: BINDINGS_MODULE(binding, type) });
  } else {
    const declared = addDeclaration(
      bindingsFile,
      current,
      binding,
      `export const ${binding} = new InjectionToken<${type}>('${binding}');`,
    ).source;
    const provided = addToModule(
      bindingsFile,
      declared,
      'providers',
      `defineProvider(${binding}, { useFactory: (env) => env.${binding}, inject: [ENV] })`,
      {
        imports: [
          { name: 'ENV', from: '@velajs/vela' },
          { name: 'InjectionToken', from: '@velajs/vela' },
          { name: 'defineProvider', from: '@velajs/vela' },
        ],
      },
    ).source;
    writes.push({
      path: bindingsFile,
      content: addToModule(bindingsFile, provided, 'exports', binding).source,
    });
  }
  const imported = addToModule(root.from, root.source, 'imports', 'BindingsModule', {
    imports: [
      { name: 'BindingsModule', from: importSpecifier(root.from, bindingsFile, root.source) },
    ],
    module: root.name,
  });
  if (imported.changed) writes.push({ path: root.from, content: imported.source });
  notes.push(
    `Inject it anywhere with @Inject(${binding}) ${binding.toLowerCase()}: ${type} (import ${binding} from ${relative(cwd, bindingsFile).split(sep).join('/')}), or read ENV.${binding}.`,
  );
  return { writes, notes };
}

/**
 * `vela add <d1|kv|r2|queue> <BINDING>`: create the resource with the
 * project's Wrangler (which adds the binding to the Wrangler file), register
 * it in the application, and refresh the binding types. The module edits are
 * planned first: when one cannot be made, nothing is created or written.
 */
export async function addResource(options: AddOptions): Promise<void> {
  const { resource, binding, log } = options;
  if (!BINDING.test(binding)) throw new Error(`${JSON.stringify(binding)} is not a binding name.`);
  const configPath = options.config
    ? resolve(options.cwd, options.config)
    : (await findWranglerConfig(options.cwd)).path;
  if (configPath === undefined) {
    throw new Error(
      'No Wrangler configuration found in the working directory; pass --config <file>.',
    );
  }
  const config = await readWranglerConfig(configPath);
  const project = dirname(configPath);
  if (declaredBindings(config, options.environment).has(binding)) {
    throw new Error(
      `${binding} is already a binding in ${relative(options.cwd, configPath) || configPath}.`,
    );
  }
  const name =
    options.name ?? `${wranglerWorkerName(config, options.environment)}-${kebabCase(binding)}`;
  const envArgs = options.environment === undefined ? [] : ['--env', options.environment];
  // Wrangler finds the default file itself; any other one it is told.
  const configArgs = options.config === undefined ? [] : ['--config', configPath];
  const defaultConfig = (await findWranglerConfig(project)).path;
  const entry = wranglerMain(config, options.environment);
  let registration: RegistrationPlan;
  try {
    const root = options.skipImport ? undefined : await rootModule(entry);
    registration = await planRegistration(resource, binding, root, entry, options.cwd);
  } catch (error) {
    if (!(error instanceof SourceEditError)) throw error;
    throw new Error(
      `${error.message}\nNothing was created; register the binding yourself or pass --skip-import.`,
      { cause: error },
    );
  }

  if (resource === 'queue') {
    wrangler(project, ['queues', 'create', name, ...configArgs]);
    const base =
      options.environment === undefined ? ['queues'] : ['env', options.environment, 'queues'];
    const changes: SyncChange[] = [
      { path: [...base, 'producers'], value: { binding, queue: name }, op: 'append', summary: '' },
      { path: [...base, 'consumers'], value: { queue: name }, op: 'append', summary: '' },
    ];
    if (config.format === 'toml') {
      log(
        `Add the queue to ${configPath}:\n[[queues.producers]]\nbinding = "${binding}"\nqueue = "${name}"\n\n[[queues.consumers]]\nqueue = "${name}"`,
      );
    } else {
      await writeFile(configPath, applyCloudflareSync(config.text, changes), 'utf8');
    }
  } else {
    const create = {
      d1: ['d1', 'create', name],
      kv: ['kv', 'namespace', 'create', name],
      r2: ['r2', 'bucket', 'create', name],
    }[resource];
    wrangler(project, [
      ...create,
      '--binding',
      binding,
      '--update-config',
      ...envArgs,
      ...configArgs,
    ]);
  }
  for (const { path, content } of registration.writes) {
    // eslint-disable-next-line no-await-in-loop -- One file after the other.
    await writeFile(path, content, 'utf8');
  }
  await refreshTypes(project, configPath === defaultConfig ? undefined : configPath, log);
  for (const note of registration.notes) log(note);
}
