import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Cli } from 'clipanion';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTemplate } from '../new-project.js';
import { AddCommand } from './add.command.js';

let project: string;

// The project's Wrangler, replaced by a script that records its arguments.
const WRANGLER_STUB = `import { appendFileSync } from 'node:fs';
appendFileSync('wrangler-calls.log', JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.WRANGLER_STUB_FAIL === process.argv[2]) process.exit(7);
`;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'vela-add-'));
  for (const [file, content] of await renderTemplate('demo')) {
    await mkdir(dirname(join(project, file)), { recursive: true });
    await writeFile(join(project, file), content);
  }
  // No types script: the command runs `wrangler types` itself.
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  delete manifest.scripts.types;
  await writeFile(join(project, 'package.json'), JSON.stringify(manifest, null, 2));
  await mkdir(join(project, 'node_modules/wrangler/bin'), { recursive: true });
  await writeFile(
    join(project, 'node_modules/wrangler/package.json'),
    JSON.stringify({ name: 'wrangler', type: 'module', bin: { wrangler: './bin/wrangler.js' } }),
  );
  await writeFile(join(project, 'node_modules/wrangler/bin/wrangler.js'), WRANGLER_STUB);
  vi.spyOn(process, 'cwd').mockReturnValue(project);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(project, { recursive: true, force: true });
});

async function add(...args: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  const collect = (chunk: Buffer) => (output += String(chunk));
  stdout.on('data', collect);
  stderr.on('data', collect);
  const code = await Cli.from([AddCommand], { binaryName: 'vela' }).run(['add', ...args], {
    stdout,
    stderr,
  });
  return { code, output };
}

const read = (file: string) => readFile(join(project, file), 'utf8');
const calls = async () =>
  (await read('wrangler-calls.log'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

describe('vela add', () => {
  it.each([
    ['d1', 'DB', ['d1', 'create', 'demo-db'], 'D1Database'],
    ['kv', 'CACHE', ['kv', 'namespace', 'create', 'demo-cache'], 'KVNamespace'],
    ['r2', 'UPLOADS', ['r2', 'bucket', 'create', 'demo-uploads'], 'R2Bucket'],
  ] as const)(
    'creates a %s resource with Wrangler, refreshes types and provides %s',
    async (kind, binding, create, type) => {
      const result = await add(kind, binding);
      expect(result.code, result.output).toBe(0);
      expect(await calls()).toEqual([
        [...create, '--binding', binding, '--update-config'],
        ['types', '--include-runtime=false'],
      ]);
      const bindings = await read('src/bindings.module.ts');
      expect(bindings).toContain(
        `export const ${binding} = new InjectionToken<${type}>('${binding}');`,
      );
      expect(bindings).toContain(
        `defineProvider(${binding}, { useFactory: (env) => env.${binding}, inject: [ENV] })`,
      );
      expect(bindings).toContain(`exports: [${binding}]`);
      expect(bindings).toContain('@Global()');
      const app = await read('src/app.module.ts');
      expect(app).toContain("import { BindingsModule } from './bindings.module.js';");
      expect(app).toContain('imports: [BindingsModule],');
      expect(result.output).toContain(`@Inject(${binding})`);
    },
  );

  it('adds further bindings to the same module', async () => {
    expect((await add('d1', 'DB', '--name', 'orders')).code).toBe(0);
    expect((await add('kv', 'SESSIONS')).code).toBe(0);
    expect((await calls())[2]).toEqual([
      'kv',
      'namespace',
      'create',
      'demo-sessions',
      '--binding',
      'SESSIONS',
      '--update-config',
    ]);
    expect((await calls())[0]).toEqual([
      'd1',
      'create',
      'orders',
      '--binding',
      'DB',
      '--update-config',
    ]);
    const bindings = await read('src/bindings.module.ts');
    expect(bindings).toContain(`export const DB = new InjectionToken<D1Database>('DB');
export const SESSIONS = new InjectionToken<KVNamespace>('SESSIONS');`);
    expect(bindings).toContain('exports: [DB, SESSIONS]');
    expect((await read('src/app.module.ts')).match(/BindingsModule/g)).toHaveLength(2);
  });

  it('creates a queue, declares its producer and consumer, and registers it', async () => {
    const result = await add('queue', 'EMAILS');
    expect(result.code, result.output).toBe(0);
    expect(await calls()).toEqual([
      ['queues', 'create', 'demo-emails'],
      ['types', '--include-runtime=false'],
    ]);
    const wrangler = parse(await read('wrangler.jsonc'), [], { allowTrailingComma: true });
    expect(wrangler.queues).toEqual({
      producers: [{ binding: 'EMAILS', queue: 'demo-emails' }],
      consumers: [{ queue: 'demo-emails' }],
    });
    expect(await read('wrangler.jsonc')).toContain('// Dates from 2026-08-04 enable');
    const app = await read('src/app.module.ts');
    expect(app).toContain(`  imports: [
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    QueueModule.registerQueue({ name: 'emails', binding: 'EMAILS' }),
  ],`);
    expect(result.output).toContain("@InjectQueue('emails')");
  });

  it('adds no queue driver when another module configures one', async () => {
    await mkdir(join(project, 'src/infra'), { recursive: true });
    await writeFile(
      join(project, 'src/infra/infra.module.ts'),
      `import { Module } from '@velajs/vela';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { QueueModule } from '@velajs/vela/queue';

@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() })] })
export class InfraModule {}
`,
    );
    const result = await add('queue', 'EMAILS');
    expect(result.code, result.output).toBe(0);
    const app = await read('src/app.module.ts');
    expect(app).not.toContain('QueueModule.forRoot');
    expect(app).toContain("QueueModule.registerQueue({ name: 'emails', binding: 'EMAILS' })");
    const skipped = await add('queue', 'AUDIT', '--skip-import');
    expect(skipped.code, skipped.output).toBe(0);
    expect(skipped.output).not.toContain('QueueModule.forRoot');
  });

  it('prints the registration with --skip-import for a root it cannot edit', async () => {
    await writeFile(
      join(project, 'src/worker.ts'),
      `import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

const Root = { module: AppModule, providers: [] };
export default createCloudflareWorker(Root);
`,
    );
    const skipped = await add('kv', 'CACHE', '--skip-import');
    expect(skipped.code, skipped.output).toBe(0);
    expect(skipped.output).toContain('Provide it yourself');
    const queue = await add('queue', 'JOBS', '--skip-import');
    expect(queue.code, queue.output).toBe(0);
    expect(queue.output).toContain("QueueModule.registerQueue({ name: 'jobs', binding: 'JOBS' })");
    expect((await calls()).map((call) => call[0])).toEqual(['kv', 'types', 'queues', 'types']);
  });

  it('fails before creating anything when it cannot find the root module to edit', async () => {
    await writeFile(
      join(project, 'src/worker.ts'),
      `import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

export default createCloudflareWorker({ module: AppModule });
`,
    );
    const before = await read('wrangler.jsonc');
    for (const kind of ['kv', 'queue']) {
      const result = await add(kind, 'CACHE');
      expect(result.code).toBe(1);
      expect(result.output).toContain('pass --skip-import');
    }
    await expect(read('wrangler-calls.log')).rejects.toThrow();
    expect(await read('wrangler.jsonc')).toBe(before);
  });

  it('registers in a root module the file exports by default', async () => {
    const app = await read('src/app.module.ts');
    await writeFile(
      join(project, 'src/app.module.ts'),
      `${app.replace('export class AppModule', 'class AppModule')}\nexport default AppModule;\n`,
    );
    await writeFile(
      join(project, 'src/worker.ts'),
      (await read('src/worker.ts')).replace('{ AppModule }', 'AppModule'),
    );
    const kv = await add('kv', 'CACHE');
    expect(kv.code, kv.output).toBe(0);
    expect(await read('src/app.module.ts')).toContain('imports: [BindingsModule],');
    const queue = await add('queue', 'EMAILS');
    expect(queue.code, queue.output).toBe(0);
    expect(await read('src/app.module.ts')).toContain(
      "QueueModule.registerQueue({ name: 'emails', binding: 'EMAILS' })",
    );
  });

  it('registers in the root module a barrel re-exports', async () => {
    const app = (await read('src/app.module.ts')).replaceAll("from './", "from '../");
    await mkdir(join(project, 'src/core'), { recursive: true });
    await writeFile(join(project, 'src/core/root.module.ts'), app);
    await writeFile(join(project, 'src/app.module.ts'), "export * from './core/root.module.js';\n");
    const kv = await add('kv', 'CACHE');
    expect(kv.code, kv.output).toBe(0);
    expect(await read('src/core/bindings.module.ts')).toContain('exports: [CACHE]');
    expect(await read('src/core/root.module.ts')).toContain(
      "import { BindingsModule } from './bindings.module.js';",
    );
    const queue = await add('queue', 'EMAILS');
    expect(queue.code, queue.output).toBe(0);
    expect(await read('src/core/root.module.ts')).toContain(
      "QueueModule.registerQueue({ name: 'emails', binding: 'EMAILS' })",
    );
    expect(await read('src/app.module.ts')).toBe("export * from './core/root.module.js';\n");
    await expect(read('src/bindings.module.ts')).rejects.toThrow();
  });

  it.each([
    [
      'a root module with computed metadata',
      'src/app.module.ts',
      `import { Module } from '@velajs/vela';

const metadata = { providers: [] };

@Module(metadata)
export class AppModule {}
`,
      'takes a computed argument',
    ],
    [
      'a root module whose metadata spreads its imports',
      'src/app.module.ts',
      `import { Module } from '@velajs/vela';
import { OpenApiModule } from '@velajs/vela/openapi';
import { AppController } from './app.controller.js';

const shared = { imports: [OpenApiModule.forRoot({ info: { title: 'Demo', version: '1' } })] };

@Module({ ...shared, controllers: [AppController] })
export class AppModule {}
`,
      'a spread or computed key in @Module() may set imports',
    ],
    [
      'a root module re-exported from a missing file',
      'src/app.module.ts',
      `export { AppModule } from './root.module.js';\n`,
      "re-exports AppModule from './root.module.js', which does not exist",
    ],
    [
      'a barrel that exports no module class',
      'src/app.module.ts',
      `export * from './missing.module.js';\n`,
      'declares no @Module() class AppModule',
    ],
    [
      'a bindings module it cannot parse',
      'src/bindings.module.ts',
      `import { Module } from '@velajs/vela';\n\n@Module({ providers: [ })\nexport class BindingsModule {}\n`,
      'Cannot parse',
    ],
    [
      'a bindings module whose metadata spreads its providers',
      'src/bindings.module.ts',
      `import { Global, Module } from '@velajs/vela';\n\nconst base = { providers: [], exports: [] };\n\n@Global()\n@Module({ ...base })\nexport class BindingsModule {}\n`,
      'a spread or computed key in @Module() may set providers',
    ],
  ])('creates nothing for %s', async (_case, file, content, message) => {
    await writeFile(join(project, file), content);
    const before = await read('wrangler.jsonc');
    for (const kind of file.endsWith('bindings.module.ts') ? ['kv'] : ['kv', 'queue']) {
      const result = await add(kind, 'CACHE');
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(message);
      expect(result.output).toContain('Nothing was created');
    }
    await expect(read('wrangler-calls.log')).rejects.toThrow();
    expect(await read('wrangler.jsonc')).toBe(before);
    expect(await read(file)).toBe(content);
    if (!file.endsWith('bindings.module.ts')) {
      await expect(read('src/bindings.module.ts')).rejects.toThrow();
    }
  });

  it('runs Wrangler against the Wrangler file --config names', async () => {
    await writeFile(join(project, 'wrangler.staging.jsonc'), await read('wrangler.jsonc'));
    const staging = join(project, 'wrangler.staging.jsonc');
    const result = await add('kv', 'CACHE', '--config', 'wrangler.staging.jsonc');
    expect(result.code, result.output).toBe(0);
    expect(await calls()).toEqual([
      [
        'kv',
        'namespace',
        'create',
        'demo-cache',
        '--binding',
        'CACHE',
        '--update-config',
        '--config',
        staging,
      ],
      ['types', '--include-runtime=false', '--config', staging],
    ]);
    expect((await add('queue', 'JOBS', '--config', 'wrangler.staging.jsonc')).code).toBe(0);
    expect((await calls())[2]).toEqual(['queues', 'create', 'demo-jobs', '--config', staging]);
    expect(await read('wrangler.staging.jsonc')).toContain('"binding": "JOBS"');
    expect(await read('wrangler.jsonc')).not.toContain('JOBS');
  });

  it('leaves the types script to the default Wrangler file', async () => {
    const manifest = JSON.parse(await read('package.json'));
    manifest.scripts.types = "node -e \"require('node:fs').writeFileSync('types-ran', '')\"";
    await writeFile(join(project, 'package.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(project, 'wrangler.staging.jsonc'), await read('wrangler.jsonc'));
    const result = await add('kv', 'CACHE', '--config', 'wrangler.staging.jsonc');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(
      'wrangler types --include-runtime=false --config wrangler.staging.jsonc',
    );
    await expect(read('types-ran')).rejects.toThrow();
  });

  it('keeps the configuration when Wrangler fails', async () => {
    vi.stubEnv('WRANGLER_STUB_FAIL', 'd1');
    const before = await read('src/app.module.ts');
    const result = await add('d1', 'DB');
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      'wrangler d1 create demo-db --binding DB --update-config failed',
    );
    expect(await read('src/app.module.ts')).toBe(before);
    await expect(read('src/bindings.module.ts')).rejects.toThrow();
  });

  it('registers a created resource when only the type refresh fails', async () => {
    vi.stubEnv('WRANGLER_STUB_FAIL', 'types');
    const result = await add('kv', 'CACHE');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Warning: wrangler types failed');
    expect(await read('src/bindings.module.ts')).toContain('exports: [CACHE]');
    expect(await read('src/app.module.ts')).toContain('imports: [BindingsModule],');
  });

  it('rejects an unknown kind, an invalid or taken binding', async () => {
    expect((await add('hyperdrive', 'DB')).output).toContain('must be one of');
    expect((await add('kv', 'my-cache')).output).toContain('is not a binding name');
    expect((await add('queue', 'EMAILS')).code).toBe(0);
    const taken = await add('kv', 'EMAILS');
    expect(taken.code).toBe(1);
    expect(taken.output).toContain('EMAILS is already a binding');
  });

  it.each(['delete', 'class', 'await', 'eval', 'arguments', 'enum', 'static'])(
    'rejects the reserved word %s as a binding name before creating anything',
    async (binding) => {
      const result = await add('kv', binding);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        `${binding} is a JavaScript reserved word; vela add declares the binding as a constant, so choose another name.`,
      );
      await expect(read('wrangler-calls.log')).rejects.toThrow();
      await expect(read('src/bindings.module.ts')).rejects.toThrow();
    },
  );

  it.each(['ENV', 'Module', 'Global', 'InjectionToken', 'defineProvider', 'BindingsModule'])(
    'rejects %s, a name the bindings module already uses, before creating anything',
    async (binding) => {
      const result = await add('d1', binding);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        `${binding} would collide with a name src/bindings.module.ts declares or imports; choose another binding name.`,
      );
      await expect(read('wrangler-calls.log')).rejects.toThrow();
    },
  );

  it('rejects a name an existing bindings module imports from elsewhere', async () => {
    await writeFile(
      join(project, 'src/bindings.module.ts'),
      `import { ENV, Global, InjectionToken, Module, defineProvider } from '@velajs/vela';
import { Logger } from './logging.js';

@Global()
@Module({ providers: [Logger], exports: [Logger] })
export class BindingsModule {}
`,
    );
    const result = await add('kv', 'Logger');
    expect(result.code).toBe(1);
    expect(result.output).toContain('Logger would collide with a name src/bindings.module.ts');
    await expect(read('wrangler-calls.log')).rejects.toThrow();
  });

  it('registers through an existing bindings module whatever its class is called', async () => {
    const bindings = `import { ENV, Global, InjectionToken, Module, defineProvider } from '@velajs/vela';

export const DB = new InjectionToken<D1Database>('DB');

@Global()
@Module({
  providers: [defineProvider(DB, { useFactory: (env) => env.DB, inject: [ENV] })],
  exports: [DB],
})
export class PlatformBindings {}
`;
    await writeFile(join(project, 'src/bindings.module.ts'), bindings);
    const result = await add('kv', 'CACHE');
    expect(result.code, result.output).toBe(0);
    const app = await read('src/app.module.ts');
    expect(app).toContain("import { PlatformBindings } from './bindings.module.js';");
    expect(app).toContain('imports: [PlatformBindings],');
    expect(app).not.toContain('BindingsModule');
    const updated = await read('src/bindings.module.ts');
    expect(updated).toContain('exports: [DB, CACHE]');
    expect(updated).toContain('export class PlatformBindings {}');
    // Its class name is taken as well.
    const collision = await add('kv', 'PlatformBindings');
    expect(collision.code).toBe(1);
    expect(collision.output).toContain('PlatformBindings would collide');

    // A bindings module that does not export its class cannot be imported.
    await writeFile(
      join(project, 'src/bindings.module.ts'),
      bindings.replace('export class PlatformBindings', 'class PlatformBindings'),
    );
    const unexported = await add('kv', 'SESSIONS');
    expect(unexported.code).toBe(1);
    expect(unexported.output).toContain(
      'src/bindings.module.ts does not export its module class PlatformBindings by name',
    );
    expect(unexported.output).toContain('Nothing was created');
    expect((await calls()).map((call) => call[0])).toEqual(['kv', 'types']);
  });

  it('refuses a root module that imports another BindingsModule, creating nothing', async () => {
    const app = `import { Module } from '@velajs/vela';
import { BindingsModule } from './platform/bindings.module.js';
import { AppController } from './app.controller.js';

@Module({ imports: [BindingsModule], controllers: [AppController] })
export class AppModule {}
`;
    await writeFile(join(project, 'src/app.module.ts'), app);
    const result = await add('kv', 'CACHE');
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "imports BindingsModule from './platform/bindings.module.js', not from './bindings.module.js'",
    );
    expect(result.output).toContain('Nothing was created');
    await expect(read('wrangler-calls.log')).rejects.toThrow();
    await expect(read('src/bindings.module.ts')).rejects.toThrow();
    expect(await read('src/app.module.ts')).toBe(app);
  });

  it('plans the Wrangler file edit of a queue before creating it', async () => {
    const wrangler = `{
  "name": "demo",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-20",
  "queues": "managed elsewhere",
}
`;
    await writeFile(join(project, 'wrangler.jsonc'), wrangler);
    const result = await add('queue', 'EMAILS');
    expect(result.code).toBe(1);
    expect(result.output).toContain('cannot add the EMAILS producer and its consumer');
    expect(result.output).toContain('Nothing was created');
    await expect(read('wrangler-calls.log')).rejects.toThrow();
    expect(await read('wrangler.jsonc')).toBe(wrangler);
    expect(await read('src/app.module.ts')).not.toContain('QueueModule');
  });

  it('prints the wrangler.toml steps it cannot apply and exits 2', async () => {
    await rm(join(project, 'wrangler.jsonc'));
    const toml = 'name = "demo"\nmain = "src/worker.ts"\ncompatibility_date = "2026-09-20"\n';
    await writeFile(join(project, 'wrangler.toml'), toml);
    const result = await add('queue', 'EMAILS');
    expect(result.code, result.output).toBe(2);
    expect((await calls())[0]).toEqual(['queues', 'create', 'demo-emails']);
    expect(result.output).toContain(
      'Manual steps required: vela add and Wrangler edit wrangler.json and wrangler.jsonc files only.',
    );
    expect(result.output).toContain(
      '1. Add the queue to wrangler.toml:\n[[queues.producers]]\nbinding = "EMAILS"\nqueue = "demo-emails"\n\n[[queues.consumers]]\nqueue = "demo-emails"',
    );
    expect(result.output).toContain('2. Then run your types script');
    // The Wrangler file is left to you; the module registration is done.
    expect(await read('wrangler.toml')).toBe(toml);
    expect(await read('src/app.module.ts')).toContain(
      "QueueModule.registerQueue({ name: 'emails', binding: 'EMAILS' })",
    );
  });

  it.each([
    [
      'd1',
      'DB',
      '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "demo-db"\ndatabase_id = "<the database_id Wrangler printed above>"',
    ],
    ['kv', 'CACHE', '[[kv_namespaces]]\nbinding = "CACHE"\nid = "<the id Wrangler printed above>"'],
    ['r2', 'UPLOADS', '[[r2_buckets]]\nbinding = "UPLOADS"\nbucket_name = "demo-uploads"'],
  ] as const)(
    'prints the wrangler.toml binding of a %s resource, which Wrangler does not write, and exits 2',
    async (kind, binding, table) => {
      await rm(join(project, 'wrangler.jsonc'));
      const toml = 'name = "demo"\nmain = "src/worker.ts"\ncompatibility_date = "2026-09-20"\n';
      await writeFile(join(project, 'wrangler.toml'), toml);
      const result = await add(kind, binding);
      expect(result.code, result.output).toBe(2);
      // Wrangler creates the resource and prints the snippet; it edits JSON files only.
      expect((await calls())[0]).toContain('--update-config');
      expect(result.output).toContain(`1. Add the binding to wrangler.toml:\n${table}`);
      expect(result.output).toContain('2. Then run your types script');
      expect(await read('wrangler.toml')).toBe(toml);
      // The module registration is done.
      expect(await read('src/bindings.module.ts')).toContain(`exports: [${binding}]`);

      // A named environment gets its own table.
      await writeFile(
        join(project, 'wrangler.toml'),
        `${toml}\n[env.staging]\nname = "demo-staging"\n`,
      );
      const staged = await add(kind, `${binding}_STAGING`, '--env', 'staging');
      expect(staged.code, staged.output).toBe(2);
      expect(staged.output).toContain(`[[env.staging.${table.slice(2, table.indexOf(']'))}]]`);
    },
  );

  it('exits 0 with --skip-import, printing the registration it leaves to you', async () => {
    const result = await add('kv', 'CACHE', '--skip-import');
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('Manual steps required');
    expect(result.output).toContain('Provide it yourself');
  });

  it('keeps a root module that lists the bindings module through a path alias or barrel', async () => {
    const app = await read('src/app.module.ts');
    const aliased = `import { BindingsModule } from '@/bindings.module';\n${app.replace(
      'controllers: [',
      'imports: [BindingsModule],\n  controllers: [',
    )}`;
    await writeFile(join(project, 'src/app.module.ts'), aliased);
    const first = await add('kv', 'CACHE');
    expect(first.code, first.output).toBe(0);
    // The alias may name this very file: the root stays as it is.
    expect(await read('src/app.module.ts')).toBe(aliased);
    expect(await read('src/bindings.module.ts')).toContain('exports: [CACHE]');

    // A relative barrel is followed to the file it re-exports.
    await mkdir(join(project, 'src/modules'), { recursive: true });
    await writeFile(
      join(project, 'src/modules/index.ts'),
      "export { BindingsModule } from '../bindings.module.js';\n",
    );
    const barrel = `import { BindingsModule } from './modules/index.js';\n${app}`;
    await writeFile(join(project, 'src/app.module.ts'), barrel);
    const second = await add('d1', 'DB');
    expect(second.code, second.output).toBe(0);
    const root = await read('src/app.module.ts');
    expect(root).toContain('imports: [BindingsModule],');
    expect(root.match(/import \{ BindingsModule \}/g)).toHaveLength(1);
    expect(await read('src/bindings.module.ts')).toContain('exports: [CACHE, DB]');
  });

  it.each([
    ["const CACHE = 'not-a-token';", 'CACHE'],
    ['const helpers = { version: 1 };', 'helpers'],
    ['export const { region: CACHE } = settings;', 'CACHE'],
    ["const CACHE = new InjectionToken<KVNamespace>('CACHE');", 'CACHE'],
  ])(
    'refuses a binding named like a variable the bindings module declares: %s',
    async (line, binding) => {
      const bindings = `import { ENV, Global, InjectionToken, Module, defineProvider } from '@velajs/vela';

${line}

@Global()
@Module({ providers: [], exports: [] })
export class BindingsModule {}
`;
      await writeFile(join(project, 'src/bindings.module.ts'), bindings);
      const result = await add('kv', binding);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        `${binding} would collide with a name src/bindings.module.ts declares or imports`,
      );
      await expect(read('wrangler-calls.log')).rejects.toThrow();
      expect(await read('src/bindings.module.ts')).toBe(bindings);
    },
  );

  it('reuses the token an earlier vela add declared for the same binding', async () => {
    const bindings = `import { ENV, Global, InjectionToken, Module, defineProvider } from '@velajs/vela';

export const CACHE = new InjectionToken<KVNamespace>('CACHE');

@Global()
@Module({ providers: [], exports: [] })
export class BindingsModule {}
`;
    await writeFile(join(project, 'src/bindings.module.ts'), bindings);
    const result = await add('kv', 'CACHE');
    expect(result.code, result.output).toBe(0);
    const updated = await read('src/bindings.module.ts');
    expect(updated.match(/export const CACHE/g)).toHaveLength(1);
    expect(updated).toContain(
      'defineProvider(CACHE, { useFactory: (env) => env.CACHE, inject: [ENV] })',
    );
    expect(updated).toContain('exports: [CACHE]');
  });
});
