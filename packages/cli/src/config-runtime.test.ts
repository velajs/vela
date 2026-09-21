import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from '@swc/core';
import type { Options } from '@swc/core';
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
    timeout: 15_000,
  });
}

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error('Build @velajs/cli before running its subprocess tests.');
  // Keep fixtures under this package so installed workspace packages resolve.
  temporary = mkdtempSync(join(packageDir, '.config-runtime-'));
  project = await createProject('sample-api', temporary);
  const compiler: Options = JSON.parse(readFileSync(join(project, '.swcrc'), 'utf8'));
  mkdirSync(join(project, 'dist'));
  for (const name of readdirSync(join(project, 'src'))) {
    if (name === 'worker.ts') continue; // Native Worker entry is not a Node entrypoint.
    const filename = join(project, 'src', name);
    const result = transformSync(readFileSync(filename, 'utf8'), { ...compiler, filename });
    writeFileSync(join(project, 'dist', name.replace(/\.ts$/, '.js')), result.code);
  }
});

afterAll(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

describe('compiled config workflow in Node', () => {
  it('runs the generated config through the real CLI and constructor-injected #private service', () => {
    const result = run([cli, 'doctor', '--app', '--json']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).application.routes).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/' }),
    );
    const controller = readFileSync(join(project, 'dist/app.controller.js'), 'utf8');
    expect(controller).toContain('design:paramtypes');
    expect(controller).toContain('#appService');
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
    expect(wrangler).toContain('"main": "dist/worker.js"');
    expect(wrangler).toContain('"command": "pnpm build"');
  });

  it('supports native type stripping for an erasable config importing compiled application code', () => {
    writeFileSync(
      join(project, 'typed.config.ts'),
      `
      import { VelaFactory } from '@velajs/vela';
      import { AppModule } from './dist/app.module.js';
      const prefix: string = '/typed';
      export const config = { rootModule: AppModule, createApp: () => VelaFactory.create(AppModule, { globalPrefix: prefix }) };
    `,
    );
    const result = run([cli, 'route', 'list', '--config', 'typed.config.ts', '--json']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContainEqual(expect.objectContaining({ path: '/typed/' }));
  });

  it('shows build guidance when decorated source is imported without compilation', () => {
    writeFileSync(
      join(project, 'raw.config.ts'),
      `
      import { Module } from '@velajs/vela';
      @Module({}) class App {}
      export default { rootModule: App, createApp() {} };
    `,
    );
    const result = run([cli, 'route', 'list', '--config', 'raw.config.ts']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('metadata-emitting compiler');
    expect(result.stdout + result.stderr).toContain('raw.config.ts');
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

  it('imports config and client helpers without optional hosts or the CLI command runtime', () => {
    const loader = `data:text/javascript,${encodeURIComponent(`
      export function resolve(specifier, context, nextResolve) {
        if (specifier === 'clipanion' || specifier.startsWith('@modelcontextprotocol/') || specifier.startsWith('@velajs/studio-')) {
          throw new Error('Unexpected optional/command import: ' + specifier);
        }
        return nextResolve(specifier, context);
      }
    `)}`;
    const register = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`)}`;
    const clientModule = pathToFileURL(join(packageDir, 'dist/client-contract.js')).href;
    const result = run([
      '--import',
      register,
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
