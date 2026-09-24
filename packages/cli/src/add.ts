import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { applyCloudflareSync, kebabCase, type SyncChange } from './cf-sync.js';
import { addDeclaration, addToModule, workerRootImport } from './generate/source-editor.js';
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

/** Regenerate worker-configuration.d.ts: the project's types script, else `wrangler types`. */
async function refreshTypes(project: string, log: (line: string) => void): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
  if (typeof scripts.types !== 'string') {
    wrangler(project, ['types', '--include-runtime=false']);
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

/** The root module file: what the Worker entry passes to createCloudflareWorker(). */
async function rootModule(
  config: WranglerConfig,
  environment: string | undefined,
): Promise<string> {
  const entry = wranglerMain(config, environment);
  const root = workerRootImport(entry, await readFile(entry, 'utf8'));
  if (!root) {
    throw new Error(
      `${entry} does not export createCloudflareWorker(AppModule); register the binding yourself or pass --skip-import.`,
    );
  }
  const target = resolve(dirname(entry), root.from);
  return target.endsWith('.ts') ? target : `${target.replace(/\.(?:js|mjs)$/, '')}.ts`;
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

/**
 * `vela add <d1|kv|r2|queue> <BINDING>`: create the resource with the
 * project's Wrangler (which adds the binding to the Wrangler file), refresh
 * the binding types, and register it in the application.
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

  if (resource === 'queue') {
    wrangler(project, ['queues', 'create', name]);
    const base =
      options.environment === undefined ? ['queues'] : ['env', options.environment, 'queues'];
    const changes: SyncChange[] = [
      { path: [...base, 'producers'], value: { binding, queue: name }, append: true, summary: '' },
      { path: [...base, 'consumers'], value: { queue: name }, append: true, summary: '' },
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
    wrangler(project, [...create, '--binding', binding, '--update-config', ...envArgs]);
  }
  await refreshTypes(project, log);

  const root = await rootModule(config, options.environment);
  const rootSource = await readFile(root, 'utf8');
  if (resource === 'queue') {
    const queueName = kebabCase(binding).replace(/-queue$/, '') || kebabCase(binding);
    const registration = `QueueModule.registerQueue({ name: '${queueName}', binding: '${binding}' })`;
    if (options.skipImport) {
      log(
        `Register it in the root module: QueueModule.forRoot({ driver: cloudflareQueues() }) (once) and ${registration}.`,
      );
    } else {
      const withDriver = addToModule(
        root,
        rootSource,
        'imports',
        'QueueModule.forRoot({ driver: cloudflareQueues() })',
        {
          imports: [
            { name: 'QueueModule', from: '@velajs/vela/queue' },
            { name: 'cloudflareQueues', from: '@velajs/cloudflare/queues' },
          ],
          unless: /^QueueModule\.forRoot(?:Async)?\(/,
        },
      );
      const registered = addToModule(root, withDriver.source, 'imports', registration, {
        imports: [{ name: 'QueueModule', from: '@velajs/vela/queue' }],
      });
      if (registered.changed || withDriver.changed)
        await writeFile(root, registered.source, 'utf8');
    }
    log(
      `Inject its client with @InjectQueue('${queueName}') client: QueueClient, and process its jobs with @Processor('${queueName}').`,
    );
    return;
  }

  const type = TYPES[resource];
  const bindingsFile = join(dirname(root), 'bindings.module.ts');
  if (options.skipImport) {
    log(
      `Provide it yourself: export const ${binding} = new InjectionToken<${type}>('${binding}'), ` +
        `provided by defineProvider(${binding}, { useFactory: (env) => env.${binding}, inject: [ENV] }).`,
    );
    return;
  }
  let bindings: string;
  try {
    const current = await readFile(bindingsFile, 'utf8');
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
    bindings = addToModule(bindingsFile, provided, 'exports', binding).source;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
    bindings = BINDINGS_MODULE(binding, type);
  }
  await writeFile(bindingsFile, bindings, 'utf8');
  const imported = addToModule(root, rootSource, 'imports', 'BindingsModule', {
    imports: [{ name: 'BindingsModule', from: importSpecifier(root, bindingsFile, rootSource) }],
  });
  if (imported.changed) await writeFile(root, imported.source, 'utf8');
  log(
    `Inject it anywhere with @Inject(${binding}) ${binding.toLowerCase()}: ${type} (import ${binding} from ${relative(options.cwd, bindingsFile).split(sep).join('/')}), or read ENV.${binding}.`,
  );
}
