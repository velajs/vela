import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Cli } from 'clipanion';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareSyncCommand } from './cf-sync.command.js';

// Fixtures live under this package so the workspace packages they import resolve.
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let project: string;

const WORKER = `
import { Injectable, Module } from '@velajs/vela';
import { Process, Processor, QueueModule } from '@velajs/vela/queue';
import { Cron } from '@velajs/vela/schedule';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';

const method = (target, name) => Object.getOwnPropertyDescriptor(target.prototype, name);
class Nightly { run() {} }
Cron('0 3 * * *', { dialect: 'cloudflare' })(Nightly.prototype, 'run', method(Nightly, 'run'));
Injectable()(Nightly);
class Emails { handle() {} }
Process()(Emails.prototype, 'handle', method(Emails, 'handle'));
Processor('emails')(Emails);
class AppModule {}
Module({
  imports: [
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    QueueModule.forFeature([{ name: 'emails', binding: 'EMAILS' }]),
  ],
  providers: [Nightly, Emails],
})(AppModule);

export class Counter extends DurableObject {}
export class SignupFlow extends WorkflowEntrypoint {}
export default createCloudflareWorker(AppModule);
`;

const WRANGLER = `{
  // Hand-written notes survive --write.
  "name": "shop",
  "main": "src/worker.mjs",
  "compatibility_date": "2026-09-20",
}
`;

beforeEach(() => {
  project = mkdtempSync(join(packageDir, '.test-cf-sync-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src/worker.mjs'), WORKER);
  writeFileSync(join(project, 'wrangler.jsonc'), WRANGLER);
  vi.spyOn(process, 'cwd').mockReturnValue(project);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

async function sync(...args: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  const collect = (chunk: Buffer) => (output += String(chunk));
  stdout.on('data', collect);
  stderr.on('data', collect);
  const code = await Cli.from([CloudflareSyncCommand], { binaryName: 'vela' }).run(
    ['cf', 'sync', ...args],
    { stdout, stderr },
  );
  return { code, output };
}

describe('vela cf sync', () => {
  it('lists the differences without writing, then applies them with --write', async () => {
    const check = await sync();
    expect(check.code).toBe(1);
    expect(check.output).toContain('Differences in wrangler.jsonc:');
    expect(check.output).toContain('+ triggers.crons: "0 3 * * *"');
    expect(check.output).toContain(
      '+ queues.producers: { "binding": "EMAILS", "queue": "shop-emails" }',
    );
    expect(check.output).toContain('Run vela cf sync --write');
    expect(readFileSync(join(project, 'wrangler.jsonc'), 'utf8')).toBe(WRANGLER);

    const written = await sync('--write');
    expect(written.code, written.output).toBe(0);
    expect(written.output).toContain('Updated wrangler.jsonc:');
    const text = readFileSync(join(project, 'wrangler.jsonc'), 'utf8');
    expect(text).toContain('// Hand-written notes survive --write.');
    expect(parse(text, [], { allowTrailingComma: true })).toEqual({
      name: 'shop',
      main: 'src/worker.mjs',
      compatibility_date: '2026-09-20',
      triggers: { crons: ['0 3 * * *'] },
      queues: {
        producers: [{ binding: 'EMAILS', queue: 'shop-emails' }],
        consumers: [{ queue: 'shop-emails' }],
      },
      durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
      workflows: [{ name: 'shop-signup-flow', binding: 'SIGNUP_FLOW', class_name: 'SignupFlow' }],
    });

    const again = await sync('--json');
    expect(again.code).toBe(0);
    expect(JSON.parse(again.output)).toMatchObject({
      status: 'in-sync',
      changes: [],
      warnings: [],
    });
  });

  it('keeps cron triggers no @Cron job declares, removing them only with --prune', async () => {
    const text = WRANGLER.replace(
      '"compatibility_date": "2026-09-20",',
      '"compatibility_date": "2026-09-20",\n  // Served by the entry\'s own scheduled handler.\n  "triggers": { "crons": ["0 3 * * *", "30 5 * * *"] },',
    );
    writeFileSync(join(project, 'wrangler.jsonc'), text);
    const written = await sync('--write');
    expect(written.code, written.output).toBe(0);
    expect(written.output).toContain(
      'Warning: triggers.crons: "30 5 * * *" is not declared by any @Cron job; kept (pass --prune to remove it).',
    );
    const kept = parse(readFileSync(join(project, 'wrangler.jsonc'), 'utf8'), [], {
      allowTrailingComma: true,
    });
    expect(kept.triggers).toEqual({ crons: ['0 3 * * *', '30 5 * * *'] });

    // The comparison lists the removal only when pruning.
    const check = await sync();
    expect(check.code, check.output).toBe(0);
    const prunable = await sync('--prune');
    expect(prunable.code).toBe(1);
    expect(prunable.output).toContain('- triggers.crons: "30 5 * * *" (no @Cron job declares it)');

    const pruned = await sync('--write', '--prune');
    expect(pruned.code, pruned.output).toBe(0);
    const after = parse(readFileSync(join(project, 'wrangler.jsonc'), 'utf8'), [], {
      allowTrailingComma: true,
    });
    expect(after.triggers).toEqual({ crons: ['0 3 * * *'] });
  });

  it('finds a Worker without jobs, queues or classes in sync', async () => {
    writeFileSync(
      join(project, 'src/worker.mjs'),
      `
import { Module } from '@velajs/vela';
import '@velajs/vela/queue';
import '@velajs/vela/schedule';
import { createCloudflareWorker } from '@velajs/cloudflare';
import '@velajs/cloudflare/queues';

class AppModule {}
Module({})(AppModule);
export default createCloudflareWorker(AppModule);
`,
    );
    const check = await sync('--json');
    expect(check.code, check.output).toBe(0);
    expect(JSON.parse(check.output)).toMatchObject({
      status: 'in-sync',
      changes: [],
      warnings: [],
    });
  });

  it('compares a wrangler.toml but does not rewrite it', async () => {
    rmSync(join(project, 'wrangler.jsonc'));
    const toml = 'name = "shop"\nmain = "src/worker.mjs"\ncompatibility_date = "2026-09-20"\n';
    writeFileSync(join(project, 'wrangler.toml'), toml);
    const check = await sync('--json');
    expect(check.code).toBe(1);
    expect(JSON.parse(check.output).status).toBe('out-of-sync');
    const written = await sync('--write');
    expect(written.code).toBe(1);
    expect(written.output).toContain('update wrangler.toml by hand');
    expect(readFileSync(join(project, 'wrangler.toml'), 'utf8')).toBe(toml);
  });
});
