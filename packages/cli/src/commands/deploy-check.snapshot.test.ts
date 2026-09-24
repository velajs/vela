import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeployCheckCommand } from './deploy-check.command.js';

// Fixtures live under this package so the workspace packages they import resolve.
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let project: string;

const APP = `
import { Injectable, Module, VelaFactory } from '@velajs/vela';
import { Cron } from '@velajs/vela/schedule';
class Nightly { run() {} }
Cron('0 3 * * *', { dialect: 'cloudflare' })(
  Nightly.prototype, 'run', Object.getOwnPropertyDescriptor(Nightly.prototype, 'run'),
);
Injectable()(Nightly);
class App {}
Module({ providers: [Nightly] })(App);
export default { rootModule: App, createApp: () => VelaFactory.create(App) };
`;

function wrangler(crons: string[]): void {
  writeFileSync(
    join(project, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'api',
      main: 'src/worker.ts',
      compatibility_date: '2026-09-20',
      triggers: { crons },
    }),
  );
}

beforeEach(() => {
  project = mkdtempSync(join(packageDir, '.test-deploy-check-'));
  writeFileSync(join(project, 'vela.config.mjs'), APP);
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

async function check(): Promise<{
  code: number;
  report: Record<string, unknown>;
  errors: string;
}> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  let errors = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const code = await Cli.from([DeployCheckCommand], { binaryName: 'vela' }).run(
    ['deploy', 'check', '--config', join(project, 'wrangler.jsonc'), '--json'],
    { stdout, stderr },
  );
  return { code, report: JSON.parse(output), errors };
}

describe('deploy check without a saved snapshot', () => {
  it('computes the entrypoints from the application', async () => {
    wrangler(['0 3 * * *']);
    const passed = await check();
    expect(passed.code).toBe(0);
    expect(passed.report.provenance).toMatchObject({
      entrypoints: { path: null, computed: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });

    wrangler([]);
    const failed = await check();
    expect(failed.code).toBe(1);
    expect(failed.report.errors).toContainEqual({
      code: 'missing-cron-trigger',
      message: 'No exact Wrangler trigger for handler cron "0 3 * * *".',
    });
  });

  it('keeps the JSON report on stdout while the application logs', async () => {
    writeFileSync(
      join(project, 'vela.config.mjs'),
      APP.replace(
        'class Nightly { run() {} }',
        "class Nightly { run() {} onModuleInit() { new Logger('Nightly').log('warming up'); console.log('ready'); } }",
      ).replace('import { Injectable,', 'import { Injectable, Logger,'),
    );
    wrangler(['0 3 * * *']);
    const result = await check();
    expect(result.code).toBe(0);
    expect(result.report.status).toBe('passed');
    expect(result.errors).toContain('LOG [Nightly] warming up');
    expect(result.errors).toContain('ready');
  });
});
