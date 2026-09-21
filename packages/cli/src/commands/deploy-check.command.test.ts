import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeployCheckCommand } from './deploy-check.command.js';

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

  it('uses git state at the config location, reporting clean and dirty honestly', async () => {
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
    await writeFile(join(directory, 'untracked.txt'), 'dirty');
    expect(JSON.parse((await run(['--json'])).output).provenance.dirty).toBe(true);
  });

  it('prints a visible target, provenance and safe shell-quoted follow-up', async () => {
    const result = await run();
    expect(result.output).toContain('Worker: api-staging');
    expect(result.output).toContain('Environment: staging');
    expect(result.output).toContain('Commit: unavailable (cleanliness unknown)');
    expect(result.output).toContain('Next step (not executed):');
  });
});
