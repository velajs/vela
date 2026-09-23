import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from './new-project.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(packageDir, 'dist/index.js');
const configModule = pathToFileURL(join(packageDir, 'dist/config.js')).href;
let temporary: string;
let project: string;

function run(args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: project,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/** A Node `--import` hook that fails these bare specifiers like missing packages. */
function withoutPackages(names: readonly string[], message = 'Cannot find package'): string[] {
  const loader = `data:text/javascript,${encodeURIComponent(`
    const names = ${JSON.stringify(names)};
    export function resolve(specifier, context, nextResolve) {
      if (names.some((name) => specifier === name || specifier.startsWith(name + '/'))) {
        throw Object.assign(new Error(${JSON.stringify(message)} + " '" + specifier + "'"), {
          code: 'ERR_MODULE_NOT_FOUND',
        });
      }
      return nextResolve(specifier, context);
    }
  `)}`;
  const register = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`)}`;
  return ['--import', register];
}

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error('Build @velajs/cli before running its subprocess tests.');
  // Keep fixtures under this package so installed workspace packages resolve.
  temporary = mkdtempSync(join(packageDir, '.config-runtime-'));
  project = await createProject('sample-api', temporary);
  // The generated project depends on @velajs/cli; resolve it to this package.
  mkdirSync(join(project, 'node_modules/@velajs'), { recursive: true });
  symlinkSync(packageDir, join(project, 'node_modules/@velajs/cli'), 'dir');
});

afterAll(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

describe('generated config workflow in Node', () => {
  it('runs the generated TypeScript config and its decorated sources through the real CLI', () => {
    expect(existsSync(join(project, 'dist'))).toBe(false);
    const result = run([cli, 'doctor', '--app', '--json']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      config: { path: join(project, 'vela.config.ts') },
    });
    expect(JSON.parse(result.stdout).application.routes).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/' }),
    );
    const routes = run([cli, 'route', 'list', '--json']);
    expect(routes.status, routes.stdout + routes.stderr).toBe(0);
    expect(JSON.parse(routes.stdout)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/' }),
    );
    // Constructor injection into a #private field proves Oxc emitted the metadata.
    const response = run([
      '--input-type=module',
      '--eval',
      `
      import { loadConfig } from ${JSON.stringify(configModule)};
      const config = await loadConfig();
      const app = await config.createApp();
      try {
        const response = await app.getHonoApp().request('http://localhost/');
        if (response.status !== 200) throw new Error(await response.text());
        console.log(JSON.stringify(await response.json()));
      } finally { await app.dispose(); }
    `,
    ]);
    expect(response.status, response.stdout + response.stderr).toBe(0);
    expect(JSON.parse(response.stdout)).toEqual({ message: 'Hello from Vela!' });
    const wrangler = readFileSync(join(project, 'wrangler.jsonc'), 'utf8');
    expect(wrangler).toContain('"main": "src/worker.ts"');
    expect(existsSync(join(project, 'dist'))).toBe(false);
  });

  it('loads another TypeScript config that imports the decorated application', () => {
    writeFileSync(
      join(project, 'typed.config.ts'),
      `
      import { VelaFactory } from '@velajs/vela';
      import { AppModule } from './src/app.module.js';
      const prefix: string = '/typed';
      export const config = { rootModule: AppModule, createApp: () => VelaFactory.create(AppModule, { globalPrefix: prefix }) };
    `,
    );
    const result = run([cli, 'route', 'list', '--config', 'typed.config.ts', '--json']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContainEqual(expect.objectContaining({ path: '/typed/' }));
  });

  it('falls back to Node without vite, with guidance for decorated TypeScript', () => {
    writeFileSync(
      join(project, 'raw.config.ts'),
      `
      import { Module } from '@velajs/vela';
      @Module({}) class App {}
      export default { rootModule: App, createApp() {} };
    `,
    );
    const raw = run([
      ...withoutPackages(['vite']),
      cli,
      'route',
      'list',
      '--config',
      'raw.config.ts',
    ]);
    expect(raw.status).toBe(1);
    expect(raw.stdout + raw.stderr).toContain('raw.config.ts');
    expect(raw.stdout + raw.stderr).toContain('Install vite 8');

    // Node itself still loads a config that needs no decorator transform.
    writeFileSync(
      join(project, 'plain.config.mjs'),
      `
      import { Module, VelaFactory } from '@velajs/vela';
      class Empty {}
      Module({})(Empty);
      export default { rootModule: Empty, createApp: () => VelaFactory.create(Empty) };
    `,
    );
    const plain = run([
      ...withoutPackages(['vite']),
      cli,
      'route',
      'list',
      '--config',
      'plain.config.mjs',
      '--json',
    ]);
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(JSON.parse(plain.stdout)).toEqual([]);
  });

  it('does not import a throwing config during default doctor inspection', () => {
    writeFileSync(
      join(project, 'throw.config.mjs'),
      `throw new Error('this config must not run');`,
    );
    const result = run([cli, 'doctor', '--config', 'throw.config.mjs', '--json']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ config: { source: 'explicit' }, issues: [] });
  });

  it('imports config and client helpers without vite, optional hosts or the CLI command runtime', () => {
    const clientModule = pathToFileURL(join(packageDir, 'dist/client-contract.js')).href;
    const result = run([
      ...withoutPackages(
        [
          'vite',
          'clipanion',
          '@modelcontextprotocol',
          '@velajs/studio-host',
          '@velajs/studio-protocol',
          '@velajs/studio-ui',
        ],
        'Unexpected optional/command import:',
      ),
      '--input-type=module',
      '--eval',
      `
      const config = await import(${JSON.stringify(configModule)});
      const client = await import(${JSON.stringify(clientModule)});
      console.log(typeof config.defineVelaConfig, typeof config.resolveConfig, typeof client.generateClientContract);
    `,
    ]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('function function function');
  });
});
