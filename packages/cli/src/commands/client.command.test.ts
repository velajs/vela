import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ApiResponse, Controller, Get, Module, VelaFactory } from '@velajs/vela';
import { Cli } from 'clipanion';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type LoadedVelaConfig, type VelaConfig } from '../config.js';
import { ClientGenerateCommand } from './client.command.js';

vi.mock('../config.js', () => ({ loadConfig: vi.fn() }));

/** A loaded config as loadConfig() returns it, with a runner that has nothing to close. */
function loadedConfig(config: VelaConfig): LoadedVelaConfig {
  return { config, path: '/project/vela.config.ts', dispose: vi.fn(async () => {}) };
}
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function run(args: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  let errors = '';
  stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  const cli = Cli.from([ClientGenerateCommand], { binaryName: 'vela' });
  const code = await cli.run(['client', 'generate', ...args], { stdout, stderr });
  return { code, output, errors };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vela-client-'));
  dirs.push(dir);
  const input = join(dir, 'openapi.json');
  await writeFile(
    input,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Test', version: '1' },
      paths: {
        '/health': {
          get: {
            responses: {
              200: {
                description: 'Health',
                content: { 'application/json': { schema: { type: 'boolean' } } },
              },
            },
          },
        },
      },
    }),
  );
  return { dir, input, out: join(dir, 'nested/api.ts') };
}

describe('vela client generate', () => {
  it('writes nested output and checks freshness without modifying stale files', async () => {
    const { input, out } = await fixture();
    expect((await run(['--input', input, '--out', out, '--strict'])).code).toBe(0);
    expect(await readFile(out, 'utf8')).toContain('export type AppType');
    expect((await run(['--input', input, '--out', out, '--check'])).code).toBe(0);
    await writeFile(out, '// stale');
    const stale = await run(['--input', input, '--out', out, '--check']);
    expect(stale.code).toBe(1);
    expect(stale.errors).toContain('missing or stale');
    expect(await readFile(out, 'utf8')).toBe('// stale');
  });

  it('reports unknown schemas on stderr, and strict mode preserves existing output', async () => {
    const { dir, input } = await fixture();
    await writeFile(
      input,
      JSON.stringify({
        openapi: '3.1.0',
        paths: { '/unknown': { get: { responses: { 200: { description: 'OK' } } } } },
      }),
    );
    const result = await run(['--input', input]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('output: unknown');
    expect(result.output).not.toContain('Warning:');
    expect(result.errors).toContain('no schema');
    const out = join(dir, 'existing.ts');
    await writeFile(out, '// existing');
    expect((await run(['--input', input, '--out', out, '--strict'])).code).toBe(1);
    expect(await readFile(out, 'utf8')).toBe('// existing');
  });

  it('validates flag combinations and invalid documents', async () => {
    const { input } = await fixture();
    expect((await run(['--check'])).code).toBe(1);
    expect((await run(['--input', input, '--config', 'vela.config.js'])).code).toBe(1);
    await writeFile(input, '{}');
    expect((await run(['--input', input])).code).toBe(1);
  });

  it('uses controller metadata and the runtime prefix, then disposes the app', async () => {
    @Controller('/users')
    class Users {
      @Get('/:id')
      @ApiResponse(200, {
        description: 'User',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      })
      find() {
        return { id: 'u1' };
      }
    }
    @Module({ controllers: [Users] })
    class App {}
    const app = await VelaFactory.create(App, { globalPrefix: '/api' });
    const dispose = vi.spyOn(app, 'dispose');
    vi.mocked(loadConfig).mockResolvedValue(
      loadedConfig({ rootModule: App, createApp: () => app }),
    );
    const result = await run(['--strict']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('"/api/users/:id"');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('fails on undocumented runtime routes and still disposes the app', async () => {
    @Module({})
    class App {}
    const app = await VelaFactory.create(App);
    vi.spyOn(app, 'describeRoutes').mockReturnValue([
      { method: 'GET', path: '/missing', controller: 'Missing', handler: 'find', moduleId: 'App' },
    ]);
    const dispose = vi.spyOn(app, 'dispose');
    vi.mocked(loadConfig).mockResolvedValue(
      loadedConfig({ rootModule: App, createApp: () => app }),
    );
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.output + result.errors).toContain('OpenAPI is missing GET /missing');
    expect(dispose).toHaveBeenCalledOnce();
  });
});
