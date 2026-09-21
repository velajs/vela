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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewCommand } from './new.command.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), writeFile: vi.fn(fs.writeFile) };
});

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'vela-new-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});
afterEach(async () => {
  vi.restoreAllMocks();
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
    expect(result.output).toContain('cd my-api\n  pnpm install');
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
    expect(await readdir(join(cwd, 'racing'))).toEqual(['package.json']);
    expect(await readFile(join(cwd, 'racing', 'package.json'), 'utf8')).toBe('concurrent file');
  });
});
