import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployCheckCommand } from './deploy-check.command.js';

const VITE_CONFIG = `import { cloudflare } from '@cloudflare/vite-plugin';
export default { plugins: [cloudflare()] };
`;

let directory: string;
let configPath: string;
let snapshotPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vela-preflight-'));
  configPath = join(directory, 'wrangler.jsonc');
  snapshotPath = join(directory, 'entrypoints.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'api',
      main: 'dist/worker.js',
      compatibility_date: '2026-09-20',
      build: { command: 'touch MUST_NOT_RUN' },
      env: { staging: { vars: { APP_SECRET: 'never-print-this' } } },
    }),
  );
  await writeFile(snapshotPath, '[]');
  await writeFile(
    join(directory, 'vela.config.js'),
    'throw new Error("DO NOT IMPORT APPLICATION");',
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function run(extra: string[] = [], required = true) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await Cli.from([DeployCheckCommand], { binaryName: 'vela' }).run(
    [
      'deploy',
      'check',
      ...(required
        ? ['--config', configPath, '--env', 'staging', '--entrypoints', snapshotPath]
        : []),
      ...extra,
    ],
    { stdout, stderr },
  );
  return { code, output };
}

describe('read-only deploy check command', () => {
  it('does not import app/build/upload/write and keeps secret values out of output', async () => {
    const before = await readdir(directory);
    const configBefore = await readFile(configPath, 'utf8');
    const result = await run(['--json']);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain('never-print-this');
    expect(result.output).not.toContain('touch MUST_NOT_RUN');
    expect(await readdir(directory)).toEqual(before);
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    const report = JSON.parse(result.output);
    expect(report.provenance).toMatchObject({ commit: null, dirty: null });
    expect(report.provenance.config.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.nextStep.args).toEqual([
      'exec',
      'wrangler',
      'deploy',
      '--config',
      configPath,
      '--env',
      'staging',
      '--dry-run',
    ]);
  });

  it('requires config, environment and snapshot explicitly', async () => {
    expect((await run([], false)).code).not.toBe(0);
    expect((await run(['--config', configPath, '--env', 'staging'], false)).code).not.toBe(0);
  });

  it('reports read/parse failures as failing JSON without configuration contents', async () => {
    await writeFile(configPath, '{ "secret": never-print-this }');
    const result = await run(['--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).status).toBe('failed');
    expect(result.output).not.toContain('never-print-this');
  });

  it('fails missing snapshots and oversized files', async () => {
    await rm(snapshotPath);
    expect((await run(['--json'])).code).toBe(1);
    await writeFile(snapshotPath, ' '.repeat(1024 * 1024 + 1));
    expect((await run(['--json'])).output).toContain('1 MiB');
  });

  it('reports git state without running repository filesystem-monitor hooks', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
    git('init');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture',
    );
    const clean = JSON.parse((await run(['--json'])).output);
    expect(clean.provenance.dirty).toBe(false);
    expect(clean.provenance.commit).toBe(git('rev-parse', 'HEAD').toString().trim());
    const hook = join(directory, '.git', 'preflight-monitor');
    await writeFile(hook, '#!/bin/sh\nprintf invoked > "$(dirname "$0")/monitor-ran"\n', {
      mode: 0o700,
    });
    git('config', 'core.fsmonitor', hook);
    await writeFile(join(directory, 'untracked.txt'), 'dirty');
    expect(JSON.parse((await run(['--json'])).output).provenance.dirty).toBe(true);
    expect(await readdir(join(directory, '.git'))).not.toContain('monitor-ran');
  });

  it('prints a visible target, provenance and safe shell-quoted follow-up', async () => {
    const result = await run();
    expect(result.output).toContain('Worker: api-staging');
    expect(result.output).toContain('Environment: staging');
    expect(result.output).toContain('Commit: unavailable (cleanliness unknown)');
    expect(result.output).toContain(
      `Next step (not executed): cd '${directory}' && 'pnpm' 'exec' 'wrangler' 'deploy' '--config' '${configPath}' '--env' 'staging' '--dry-run'\n`,
    );
    expect(JSON.parse((await run(['--json'])).output).nextStep.cwd).toBe(directory);
  });

  // `wrangler deploy --config` would bundle a Vite project's source with
  // esbuild, which emits no decorator metadata, instead of the Vite build.
  it.each([
    ['vite.config.ts', VITE_CONFIG],
    ['vite.config.mjs', VITE_CONFIG],
    ['.wrangler/deploy/config.json', '{}'],
  ])('builds a Vite project through Vite before the Wrangler dry-run (%s)', async (file, text) => {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), text);
    const report = JSON.parse((await run(['--json'])).output);
    expect(report.nextStep).toEqual({
      build: {
        command: 'pnpm',
        args: ['build'],
        env: { CLOUDFLARE_ENV: 'staging' },
        cwd: directory,
      },
      command: 'pnpm',
      args: ['exec', 'wrangler', 'deploy', '--env', 'staging', '--dry-run'],
      cwd: directory,
    });
    expect(report.warnings.map((issue: { code: string }) => issue.code)).not.toContain(
      'vite-config-path',
    );
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.output).toContain(
      `Next step (not executed): cd '${directory}' && CLOUDFLARE_ENV=staging pnpm build && pnpm exec wrangler deploy --env staging --dry-run\n`,
    );
    expect(result.output).not.toContain('--config');
  });

  it('keeps the Wrangler build for a Vite config without the Cloudflare Vite plugin', async () => {
    await writeFile(join(directory, 'vite.config.ts'), 'export default { plugins: [] };\n');
    const report = JSON.parse((await run(['--json'])).output);
    expect(report.nextStep).toEqual({
      command: 'pnpm',
      args: ['exec', 'wrangler', 'deploy', '--config', configPath, '--env', 'staging', '--dry-run'],
      cwd: directory,
    });
  });

  it('runs the next step in the Wrangler file directory when checked from a parent', async () => {
    const project = join(directory, "it's app");
    await mkdir(project);
    await writeFile(join(project, 'wrangler.jsonc'), await readFile(configPath, 'utf8'));
    await writeFile(join(project, 'vite.config.ts'), VITE_CONFIG);
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const args = ['--config', "it's app/wrangler.jsonc", '--env', 'staging'];

    const report = JSON.parse(
      (await run([...args, '--entrypoints', 'entrypoints.json', '--json'], false)).output,
    );
    expect(report.nextStep.cwd).toBe(project);
    expect(report.nextStep.build.cwd).toBe(project);
    const result = await run([...args, '--entrypoints', 'entrypoints.json'], false);
    expect(result.code).toBe(0);
    expect(result.output).toContain(
      `Next step (not executed): cd '${directory}/it'\\''s app' && CLOUDFLARE_ENV=staging pnpm build && pnpm exec wrangler deploy --env staging --dry-run\n`,
    );
  });

  // The Cloudflare Vite plugin reads a default-named Wrangler file unless its
  // `configPath` option names another.
  it('warns when the Vite build does not read a non-default Wrangler file by default', async () => {
    const custom = join(directory, 'wrangler.staging.jsonc');
    await writeFile(custom, await readFile(configPath, 'utf8'));
    await writeFile(join(directory, 'vite.config.ts'), VITE_CONFIG);
    const args = ['--config', custom, '--env', 'staging', '--entrypoints', snapshotPath];

    const report = JSON.parse((await run([...args, '--json'], false)).output);
    expect(report.status).toBe('passed');
    expect(report.warnings).toContainEqual({
      code: 'vite-config-path',
      message:
        'The Cloudflare Vite plugin reads wrangler.json, wrangler.jsonc or wrangler.toml by ' +
        'default; set its configPath to "./wrangler.staging.jsonc" so the build uses the checked file.',
    });
    expect((await run(args, false)).output).toContain('Warning [vite-config-path]:');

    await rm(join(directory, 'vite.config.ts'));
    const wranglerBuilt = JSON.parse((await run([...args, '--json'], false)).output);
    expect(wranglerBuilt.warnings.map((issue: { code: string }) => issue.code)).not.toContain(
      'vite-config-path',
    );
  });
});
