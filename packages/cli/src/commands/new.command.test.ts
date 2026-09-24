import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Cli } from 'clipanion';
import { parse, type ParseError } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewCommand } from './new.command.js';
import { detectPackageManager } from '../new-project.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), writeFile: vi.fn(fs.writeFile) };
});

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'vela-new-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  // The package manager defaults to the one running the command.
  vi.stubEnv('npm_config_user_agent', '');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(writeFile).mockClear();
  vi.mocked(open).mockClear();
  await rm(cwd, { recursive: true, force: true });
});

async function run(args: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  const collect = (chunk: Buffer) => (output += String(chunk));
  stdout.on('data', collect);
  stderr.on('data', collect);
  const cli = Cli.from([NewCommand], { binaryName: 'vela' });
  const code = await cli.run(args, { stdout, stderr });
  return { code, output };
}

describe('vela new', () => {
  it('creates a standalone project with public dependencies and actionable next steps', async () => {
    const result = await run(['new', 'my-api']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('cd my-api\n  pnpm install\n  pnpm run dev\n');
    expect(result.output).toContain('http://localhost:5173');
    expect(result.output).not.toContain('pnpm build');
    const project = join(cwd, 'my-api');
    const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    expect(manifest.name).toBe('my-api');
    expect(manifest.private).toBe(true);
    for (const range of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
      expect(range).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(await readFile(join(project, 'wrangler.jsonc'), 'utf8')).toContain('"name": "my-api"');
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toContain('.dev.vars');
    expect(await readFile(join(project, 'README.md'), 'utf8')).not.toContain('__PROJECT_NAME__');
    expect(await readdir(join(project, 'src'))).toEqual([
      'app.controller.ts',
      'app.module.ts',
      'app.service.ts',
      'worker.ts',
    ]);
    expect(await readdir(join(project, 'test'))).toEqual(['worker.spec.ts']);
    expect((await readdir(project)).toSorted()).toEqual([
      '.gitignore',
      'README.md',
      'oxc.config.ts',
      'package.json',
      'pnpm-workspace.yaml',
      'src',
      'test',
      'tsconfig.json',
      'vite.config.ts',
      'vitest.config.ts',
      'worker-configuration.d.ts',
      'wrangler.jsonc',
    ]);
  });

  it('exports the Worker without an environment token and types ENV from wrangler types', async () => {
    expect((await run(['new', 'typed-env'])).code).toBe(0);
    const project = join(cwd, 'typed-env');
    const worker = await readFile(join(project, 'src/worker.ts'), 'utf8');
    expect(worker).toContain('export default createCloudflareWorker(AppModule);');
    expect(worker).not.toContain('InjectionToken');
    const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    // Both regenerate the binding types first, without package-manager
    // pre-scripts; with no Wrangler build block, `wrangler types` runs no build.
    expect(manifest.scripts).toMatchObject({
      types: 'wrangler types --include-runtime=false',
      dev: 'wrangler types --include-runtime=false && vite dev',
      typecheck: 'wrangler types --include-runtime=false && tsc --noEmit',
    });
    // Committed so a fresh checkout typechecks before its first `pnpm types`.
    const generated = await readFile(join(project, 'worker-configuration.d.ts'), 'utf8');
    expect(generated).toContain('wrangler types --include-runtime=false');
    expect(generated).toContain('declare namespace Cloudflare');
    expect(generated).toContain('mainModule: typeof import("./src/worker");');
    const tsconfig = JSON.parse(await readFile(join(project, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.include).toContain('worker-configuration.d.ts');
    expect(tsconfig.compilerOptions.types).toEqual([
      '@cloudflare/workers-types',
      '@cloudflare/vitest-plugin/types',
    ]);
  });

  it('builds, serves and tests the Worker with Vite and Oxc instead of a precompile step', async () => {
    expect((await run(['new', 'vite-api'])).code).toBe(0);
    const project = join(cwd, 'vite-api');
    const read = (file: string) => readFile(join(project, file), 'utf8');
    const manifest = JSON.parse(await read('package.json'));
    expect(manifest.scripts).toMatchObject({
      build: 'vite build',
      preview: 'vite preview',
      deploy: 'vite build && wrangler deploy',
      test: 'vitest run',
    });
    for (const name of [
      '@cloudflare/vite-plugin',
      '@cloudflare/vitest-plugin',
      '@velajs/cli',
      '@velajs/testing',
      'vite',
      'vitest',
    ]) {
      expect(manifest.devDependencies).toHaveProperty(name);
    }
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(dependencies.filter((name) => name.startsWith('@swc/'))).toEqual([]);
    expect(await read('pnpm-workspace.yaml')).not.toContain('@swc/core');

    const errors: ParseError[] = [];
    const wrangler: unknown = parse(await read('wrangler.jsonc'), errors, {
      allowTrailingComma: true,
    });
    expect(errors).toEqual([]);
    expect(wrangler).toMatchObject({ main: 'src/worker.ts', compatibility_date: '2026-09-20' });
    expect(wrangler).not.toHaveProperty('build');
    // Dates from 2026-08-04 enable Node.js compatibility, node:async_hooks included.
    expect(wrangler).not.toHaveProperty('compatibility_flags');
    // The root entry imports node:async_hooks whether or not ambient access is on.
    const comment = await read('wrangler.jsonc');
    expect(comment).toContain('@velajs/vela root entry imports');
    expect(comment).toContain('whether or not ambient access is enabled');

    // One Oxc decorator setting, shared so the build and the tests cannot drift.
    expect(await read('oxc.config.ts')).toContain(
      'decorator: { legacy: true, emitDecoratorMetadata: true }',
    );
    const vite = await read('vite.config.ts');
    expect(vite).toContain("import { oxc } from './oxc.config.ts';");
    expect(vite).toContain('plugins: [cloudflare()]');
    const vitest = await read('vitest.config.ts');
    expect(vitest).toContain("import { oxc } from './oxc.config.ts';");
    expect(vitest).toContain('cloudflareTest(');
    expect(vitest).not.toContain('cloudflare()');

    const spec = await read('test/worker.spec.ts');
    expect(spec).toContain("from '@velajs/cloudflare/testing'");
    expect(spec).toContain('createTestingWorker(AppModule, { env })');
    expect(spec).toContain('.overrideProvider(AppService)');

    const tsconfig = JSON.parse(await read('tsconfig.json'));
    expect(tsconfig.compilerOptions).toMatchObject({
      verbatimModuleSyntax: true,
      isolatedModules: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    });
    expect(await read('src/app.controller.ts')).not.toContain('eslint-disable');
    // The CLI loads the Worker entry Wrangler names: no vela.config.ts.
    await expect(read('vela.config.ts')).rejects.toThrow();
    expect(await read('README.md')).toContain('pnpm exec vela route list');
    expect(await read('README.md')).not.toContain('pnpm dlx');
  });

  it('accepts an empty destination but preserves every file in a nonempty one', async () => {
    await mkdir(join(cwd, 'empty'));
    expect((await run(['new', 'empty'])).code).toBe(0);
    const original = await readFile(join(cwd, 'empty', 'package.json'), 'utf8');
    const repeated = await run(['new', 'empty']);
    expect(repeated.code).toBe(1);
    expect(repeated.output).toContain('Destination is not empty');
    expect(await readFile(join(cwd, 'empty', 'package.json'), 'utf8')).toBe(original);
    await mkdir(join(cwd, 'hidden'));
    await writeFile(join(cwd, 'hidden', '.keep'), 'keep me');
    expect((await run(['new', 'hidden'])).code).toBe(1);
    expect(await readdir(join(cwd, 'hidden'))).toEqual(['.keep']);
    expect(await readFile(join(cwd, 'hidden', '.keep'), 'utf8')).toBe('keep me');
  });

  it('rejects files and symbolic links without following or modifying them', async () => {
    await writeFile(join(cwd, 'file'), 'keep me');
    await mkdir(join(cwd, 'target'));
    await symlink(join(cwd, 'target'), join(cwd, 'linked'), 'dir');
    for (const name of ['file', 'linked']) {
      const result = await run(['new', name]);
      expect(result.code).toBe(1);
      expect(result.output).toContain('not a regular directory');
    }
    expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('keep me');
    expect((await lstat(join(cwd, 'linked'))).isSymbolicLink()).toBe(true);
    expect(await readdir(join(cwd, 'target'))).toEqual([]);
  });

  it.each([
    '../escape',
    './nested',
    '/tmp/api',
    '.',
    '@scope/api',
    'MyApi',
    'two words',
    'api_',
    'api--x',
    'api\n',
    'api-',
    '',
    'con',
    'a'.repeat(64),
  ])('rejects invalid project name %s before writing', async (name) => {
    expect((await run(['new', name])).code).toBe(1);
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each([['new'], ['new', 'api', 'extra'], ['new', 'api', '--force']])(
    'rejects missing arguments and unsupported options: %j',
    async (...args) => {
      expect((await run(args)).code).toBe(1);
      expect(await readdir(cwd)).toEqual([]);
    },
  );

  it('cleans up its partial output after a write failure', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('Disk full'));
    const result = await run(['new', 'failed']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Disk full');
    expect(await readdir(cwd)).toEqual([]);
  });

  it('preserves an existing empty directory when a later write fails', async () => {
    await mkdir(join(cwd, 'existing'));
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(writeFile)
      .mockImplementationOnce(realFs.writeFile)
      .mockRejectedValueOnce(new Error('Disk full'));
    expect((await run(['new', 'existing'])).code).toBe(1);
    expect(await readdir(join(cwd, 'existing'))).toEqual([]);
  });

  it('does not overwrite a file created after the empty-directory check', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (path, flags) => {
      await realFs.writeFile(path, 'concurrent file');
      return realFs.open(path, flags);
    });
    expect((await run(['new', 'racing'])).code).toBe(1);
    expect(await readdir(join(cwd, 'racing'))).toEqual(['.gitignore']);
    expect(await readFile(join(cwd, 'racing', '.gitignore'), 'utf8')).toBe('concurrent file');
  });

  it('creates the api template with a KV resource, a queue and a cron job', async () => {
    expect((await run(['new', 'todo-api', '--template', 'api'])).code).toBe(0);
    const project = join(cwd, 'todo-api');
    const read = (file: string) => readFile(join(project, file), 'utf8');
    expect((await readdir(join(project, 'src/todos'))).toSorted()).toEqual([
      'todo-events.processor.ts',
      'todo-events.ts',
      'todo.schemas.ts',
      'todos.controller.ts',
      'todos.cron.ts',
      'todos.module.ts',
      'todos.service.ts',
    ]);
    const manifest = JSON.parse(await read('package.json'));
    expect(manifest.dependencies).toHaveProperty('zod');
    const errors: ParseError[] = [];
    const wrangler: unknown = parse(await read('wrangler.jsonc'), errors, {
      allowTrailingComma: true,
    });
    expect(errors).toEqual([]);
    expect(wrangler).toMatchObject({
      kv_namespaces: [{ binding: 'TODOS' }],
      queues: {
        producers: [{ binding: 'TODO_EVENTS', queue: 'todo-api-todo-events' }],
        consumers: [{ queue: 'todo-api-todo-events' }],
      },
      triggers: { crons: ['0 3 * * *'] },
    });
    expect(await read('worker-configuration.d.ts')).toContain('TODOS: KVNamespace;');
    expect(await read('src/todos/todos.cron.ts')).toContain(
      "@Cron('0 3 * * *', { dialect: 'cloudflare' })",
    );
    const spec = await read('test/todos.spec.ts');
    for (const usage of ['worker.queue(', 'worker.scheduled(', '.overrideModule(', '.useMocker(']) {
      expect(spec).toContain(usage);
    }
    const readme = await read('README.md');
    expect(readme).toContain('pnpm exec wrangler queues create todo-api-todo-events');
    expect(readme).not.toMatch(/__[A-Z_]+__/);
  });

  it.each([
    ['npm', 'npm install', 'npm run', []],
    ['yarn', 'yarn install', 'yarn run', ['.yarnrc.yml']],
    ['bun', 'bun install', 'bun run', []],
  ] as const)('writes %s files and instructions', async (manager, install, runScript, extra) => {
    const result = await run(['new', 'pm-api', '--pm', manager]);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`cd pm-api\n  ${install}\n  ${runScript} dev\n`);
    const project = join(cwd, 'pm-api');
    const files = await readdir(project);
    expect(files).not.toContain('pnpm-workspace.yaml');
    for (const file of extra) expect(files).toContain(file);
    const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    expect(manifest).not.toHaveProperty('packageManager');
    if (manager === 'bun') expect(manifest.trustedDependencies).toEqual(['esbuild', 'workerd']);
    if (manager === 'yarn') {
      expect(await readFile(join(project, '.yarnrc.yml'), 'utf8')).toBe(
        'nodeLinker: node-modules\n',
      );
    }
    const readme = await readFile(join(project, 'README.md'), 'utf8');
    expect(readme).toContain(`${install}\n${runScript} dev`);
    expect(readme).not.toContain('pnpm');
  });

  it('defaults to the package manager that runs the command', () => {
    expect(detectPackageManager('npm/11.4.0 node/v24.8.0 darwin arm64')).toBe('npm');
    expect(detectPackageManager('bun/1.3.0 npm/? node/v24.3.0')).toBe('bun');
    expect(detectPackageManager('yarn/4.9.1 npm/? node/v24.8.0')).toBe('yarn');
    expect(detectPackageManager('pnpm/11.11.0 npm/? node/v24.8.0')).toBe('pnpm');
    expect(detectPackageManager('cnpm/9.0.0')).toBe('pnpm');
    expect(detectPackageManager(undefined)).toBe('pnpm');
  });

  it.each([
    ['new', 'api', '--template', 'full'],
    ['new', 'api', '--pm', 'deno'],
  ])('rejects an unknown template or package manager: %j', async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.output).toContain('must be one of');
    expect(await readdir(cwd)).toEqual([]);
  });

  it('installs with the chosen package manager and commits the project to Git', async () => {
    const bin = join(cwd, '.bin');
    await mkdir(bin);
    const npm = join(bin, 'npm');
    await writeFile(npm, '#!/bin/sh\necho "installed $*" > installed.txt\n');
    chmodSync(npm, 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    for (const [name, value] of [
      ['GIT_AUTHOR_NAME', 'Fixture'],
      ['GIT_AUTHOR_EMAIL', 'fixture@example.test'],
      ['GIT_COMMITTER_NAME', 'Fixture'],
      ['GIT_COMMITTER_EMAIL', 'fixture@example.test'],
    ] as const)
      vi.stubEnv(name, value);

    const result = await run(['new', 'ready-api', '--pm', 'npm', '--install', '--git']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('cd ready-api\n  npm run dev\n');
    const project = join(cwd, 'ready-api');
    expect(await readFile(join(project, 'installed.txt'), 'utf8')).toBe('installed install\n');
    const log = spawnSync('git', ['log', '--format=%s'], { cwd: project, encoding: 'utf8' });
    expect(log.stdout.trim()).toBe('chore: initial commit');
    const tracked = spawnSync('git', ['ls-files'], { cwd: project, encoding: 'utf8' });
    expect(tracked.stdout).toContain('src/worker.ts');
    expect(tracked.stdout).toContain('installed.txt');
  });

  it('keeps the project and fails when the install fails', async () => {
    const bin = join(cwd, '.bin');
    await mkdir(bin);
    const npm = join(bin, 'npm');
    await writeFile(npm, '#!/bin/sh\nexit 3\n');
    chmodSync(npm, 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    const result = await run(['new', 'broken-install', '--pm', 'npm', '--install']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('npm install failed');
    expect(await readdir(join(cwd, 'broken-install'))).toContain('package.json');
  });
});
