import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTemplate } from '../new-project.js';
import { GenerateCommand } from './generate.command.js';

let project: string;

async function scaffold(template: 'minimal' | 'api'): Promise<void> {
  const files = await renderTemplate('demo', { template });
  for (const [file, content] of files) {
    const path = join(project, file);
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(join(path, '..'), { recursive: true }),
    );
    await writeFile(path, content);
  }
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'vela-generate-'));
  vi.spyOn(process, 'cwd').mockReturnValue(project);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

async function generate(...args: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  const collect = (chunk: Buffer) => (output += String(chunk));
  stdout.on('data', collect);
  stderr.on('data', collect);
  const code = await Cli.from([GenerateCommand], { binaryName: 'vela' }).run(args, {
    stdout,
    stderr,
  });
  return { code, output };
}

const read = (file: string) => readFile(join(project, file), 'utf8');

describe('vela generate', () => {
  it('creates a module and imports it into the root module', async () => {
    await scaffold('minimal');
    const result = await generate('generate', 'module', 'billing');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('CREATE src/billing/billing.module.ts');
    expect(result.output).toContain('UPDATE src/app.module.ts');
    expect(await read('src/billing/billing.module.ts')).toContain('export class BillingModule {}');
    expect(await read('src/app.module.ts')).toBe(`import { Module } from '@velajs/vela';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { BillingModule } from './billing/billing.module.js';

@Module({
  controllers: [AppController],
  providers: [AppService],
  imports: [BillingModule],
})
export class AppModule {}
`);
  });

  it('registers controllers and services in the module of their directory', async () => {
    await scaffold('minimal');
    expect((await generate('g', 'module', 'billing')).code).toBe(0);
    expect((await generate('g', 'controller', 'billing')).code).toBe(0);
    expect((await generate('g', 'service', 'billing')).code).toBe(0);
    expect(await read('src/billing/billing.module.ts')).toBe(`import { Module } from '@velajs/vela';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

@Module({ controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
`);
    // Without a module of its own directory, a service registers in the root module.
    expect((await generate('g', 'service', 'audit-log')).code).toBe(0);
    expect(await read('src/app.module.ts')).toContain('providers: [AppService, AuditLogService],');
    expect(await read('src/app.module.ts')).toContain(
      "import { AuditLogService } from './audit-log/audit-log.service.js';",
    );
  });

  it('generates a resource validated by hand, or with zod when the project uses it', async () => {
    await scaffold('minimal');
    expect((await generate('g', 'resource', 'notes')).code).toBe(0);
    expect((await readdir(join(project, 'src/notes'))).toSorted()).toEqual([
      'note.types.ts',
      'notes.controller.ts',
      'notes.module.ts',
      'notes.service.ts',
    ]);
    const controller = await read('src/notes/notes.controller.ts');
    expect(controller).toContain("@Controller('/notes')");
    expect(controller).toContain('create(@Body() body: unknown): Note {');
    expect(controller).toContain('return this.#service.create(parseCreateNote(body));');
    expect(await read('src/app.module.ts')).toContain('imports: [NotesModule],');

    await rm(project, { recursive: true, force: true });
    await scaffold('api');
    expect((await generate('g', 'resource', 'categories')).code).toBe(0);
    const schemas = await read('src/categories/category.schemas.ts');
    expect(schemas).toContain("import { z } from 'zod';");
    expect(await read('src/categories/categories.controller.ts')).toContain(
      'create(@Body(CreateCategory) body: CreateCategory): Category {',
    );
    expect(await read('src/app.module.ts')).toContain(
      'imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), TodosModule, CategoriesModule],',
    );
  });

  it('adds a queue processor, its registration and the driver once', async () => {
    await scaffold('minimal');
    const first = await generate('g', 'queue', 'emails');
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain('vela cf sync --write adds the EMAILS producer');
    expect(await read('src/emails/emails.processor.ts')).toContain(
      "export const EMAILS_QUEUE = 'emails';",
    );
    expect((await generate('g', 'queue', 'reports', '--binding', 'REPORT_JOBS')).code).toBe(0);
    const app = await read('src/app.module.ts');
    expect(app).toContain(`import { QueueModule } from '@velajs/vela/queue';
import { EMAILS_QUEUE, EmailsProcessor } from './emails/emails.processor.js';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { REPORTS_QUEUE, ReportsProcessor } from './reports/reports.processor.js';`);
    expect(app).toContain(`  imports: [
    QueueModule.registerQueue({ name: EMAILS_QUEUE, binding: 'EMAILS' }),
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    QueueModule.registerQueue({ name: REPORTS_QUEUE, binding: 'REPORT_JOBS' }),
  ],`);
    expect(app).toContain('providers: [AppService, EmailsProcessor, ReportsProcessor],');
    expect(app.match(/QueueModule\.forRoot/g)).toHaveLength(1);
  });

  it('registers a queue in its module and the driver in the root module', async () => {
    await scaffold('api');
    expect(
      (await generate('g', 'queue', 'reminders', '--module', 'src/todos/todos.module.ts')).code,
    ).toBe(0);
    const todos = await read('src/todos/todos.module.ts');
    expect(todos).toContain(
      "    QueueModule.registerQueue({ name: REMINDERS_QUEUE, binding: 'REMINDERS' }),\n  ],",
    );
    expect(todos).toContain(
      "import { REMINDERS_QUEUE, RemindersProcessor } from '../reminders/reminders.processor.js';",
    );
    expect(todos).toContain(
      'providers: [TodosService, TodoEventsProcessor, TodosCleanup, RemindersProcessor],',
    );
    // The root module already configures the driver.
    expect(await read('src/app.module.ts')).toBe(
      (await renderTemplate('demo', { template: 'api' })).get('src/app.module.ts'),
    );
  });

  it('adds no queue driver when any module of the project configures one', async () => {
    await scaffold('minimal');
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
    // A spec's own testing module does not count.
    await writeFile(
      join(project, 'src/infra/infra.spec.ts'),
      "// QueueModule.forRoot({ driver: inline() })\nexport const unused = 'QueueModule.forRoot(';\n",
    );
    const result = await generate('g', 'queue', 'audit');
    expect(result.code, result.output).toBe(0);
    const app = await read('src/app.module.ts');
    expect(app).not.toContain('QueueModule.forRoot');
    expect(app).toContain("QueueModule.registerQueue({ name: AUDIT_QUEUE, binding: 'AUDIT' })");
    const skipped = await generate('g', 'queue', 'sms', '--skip-import');
    expect(skipped.code, skipped.output).toBe(0);
    expect(skipped.output).not.toContain('QueueModule.forRoot');
  });

  it('prints no driver registration with --skip-import once the root module has one', async () => {
    await scaffold('minimal');
    expect((await generate('g', 'queue', 'emails')).code).toBe(0);
    const skipped = await generate('g', 'queue', 'sms', '--skip-import');
    expect(skipped.code, skipped.output).toBe(0);
    expect(skipped.output).toContain('QueueModule.registerQueue({ name: SMS_QUEUE');
    expect(skipped.output).not.toContain('QueueModule.forRoot');
  });

  it('registers in the root module the Worker entry names, not a helper module before it', async () => {
    await scaffold('minimal');
    const app = await read('src/app.module.ts');
    await writeFile(
      join(project, 'src/app.module.ts'),
      app.replace('@Module({', '@Module({ providers: [] })\nclass InternalModule {}\n\n@Module({'),
    );
    expect((await generate('g', 'service', 'billing')).code).toBe(0);
    const edited = await read('src/app.module.ts');
    expect(edited).toContain('@Module({ providers: [] })\nclass InternalModule {}');
    expect(edited).toContain('providers: [AppService, BillingService],');
  });

  it('registers in a root module the file exports by default', async () => {
    await scaffold('minimal');
    const app = await read('src/app.module.ts');
    await writeFile(
      join(project, 'src/app.module.ts'),
      `${app.replace('export class AppModule', 'class AppModule')}\nexport default AppModule;\n`,
    );
    await writeFile(
      join(project, 'src/worker.ts'),
      (await read('src/worker.ts')).replace('{ AppModule }', 'AppModule'),
    );
    const result = await generate('g', 'service', 'billing');
    expect(result.code, result.output).toBe(0);
    expect(await read('src/app.module.ts')).toContain('providers: [AppService, BillingService],');
  });

  it.each([
    ['a named re-export', "export { AppModule } from './core/root.module.js';\n"],
    ['an export-star barrel', "export * from './core/root.module.js';\n"],
  ])('registers in the root module the entry reaches through %s', async (_case, barrel) => {
    await scaffold('minimal');
    const app = (await read('src/app.module.ts')).replaceAll("from './app.", "from '../app.");
    await mkdir(join(project, 'src/core'), { recursive: true });
    await writeFile(join(project, 'src/core/root.module.ts'), app);
    await writeFile(join(project, 'src/app.module.ts'), barrel);
    const service = await generate('g', 'service', 'billing');
    expect(service.code, service.output).toBe(0);
    expect(service.output).toContain('UPDATE src/core/root.module.ts');
    expect(await read('src/core/root.module.ts')).toContain(
      "import { BillingService } from '../billing/billing.service.js';",
    );
    expect(await read('src/core/root.module.ts')).toContain(
      'providers: [AppService, BillingService],',
    );
    const queue = await generate('g', 'queue', 'emails');
    expect(queue.code, queue.output).toBe(0);
    expect(await read('src/core/root.module.ts')).toContain(
      'QueueModule.forRoot({ driver: cloudflareQueues() })',
    );
    expect(await read('src/app.module.ts')).toBe(barrel);
  });

  it('adds a cron job with a validated Cloudflare schedule', async () => {
    await scaffold('minimal');
    const result = await generate('g', 'cron', 'digest', '--schedule', '30 6 * * MON');
    expect(result.code, result.output).toBe(0);
    expect(await read('src/digest/digest.cron.ts')).toContain(
      "@Cron('30 6 * * MON', { dialect: 'cloudflare' })",
    );
    expect(await read('src/app.module.ts')).toContain('providers: [AppService, DigestCron],');
    const invalid = await generate('g', 'cron', 'broken', '--schedule', '61 * * * *');
    expect(invalid.code).toBe(1);
    expect(invalid.output).toContain('is not a Cloudflare cron expression');
  });

  it('exports a Durable Object from the Worker entry Wrangler names', async () => {
    await scaffold('minimal');
    const result = await generate('g', 'durable-object', 'counter');
    expect(result.code, result.output).toBe(0);
    expect(await read('src/counter/counter.durable-object.ts')).toContain(
      'export class Counter extends DurableObject {',
    );
    expect(await read('src/worker.ts'))
      .toBe(`import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';
export { Counter } from './counter/counter.durable-object.js';

export default createCloudflareWorker(AppModule);
`);
    expect(result.output).toContain(
      'vela cf sync --write adds the COUNTER binding and a migration',
    );
  });

  it('prints every registration and import of a queue with --skip-import', async () => {
    await scaffold('minimal');
    const before = await read('src/app.module.ts');
    const skipped = await generate('g', 'queue', 'emails', '--skip-import');
    expect(skipped.code).toBe(0);
    const lines = skipped.output.trim().split('\n');
    expect(lines).toEqual([
      'CREATE src/emails/emails.processor.ts',
      "Register it in src/app.module.ts: add QueueModule.registerQueue({ name: EMAILS_QUEUE, binding: 'EMAILS' }) to @Module({ imports }) after import { QueueModule } from '@velajs/vela/queue'; import { EMAILS_QUEUE } from './emails/emails.processor.js';",
      "Register it in src/app.module.ts: add EmailsProcessor to @Module({ providers }) after import { EmailsProcessor } from './emails/emails.processor.js';",
      "Register it in src/app.module.ts: add QueueModule.forRoot({ driver: cloudflareQueues() }) to @Module({ imports }) after import { QueueModule } from '@velajs/vela/queue'; import { cloudflareQueues } from '@velajs/cloudflare/queues';",
      'Next: vela cf sync --write adds the EMAILS producer and its consumer, and your types script types ENV.EMAILS.',
    ]);
    expect(await read('src/app.module.ts')).toBe(before);
  });

  it('prints the registration with --skip-import and writes nothing with --dry-run', async () => {
    await scaffold('minimal');
    const before = await read('src/app.module.ts');
    const skipped = await generate('g', 'controller', 'health', '--skip-import');
    expect(skipped.code).toBe(0);
    expect(skipped.output).toContain(
      "Register it in src/app.module.ts: add HealthController to @Module({ controllers }) after import { HealthController } from './health/health.controller.js';",
    );
    expect(await read('src/app.module.ts')).toBe(before);
    expect(await read('src/health/health.controller.ts')).toContain("@Controller('/health')");

    const dry = await generate('g', 'service', 'health', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.output).toContain('CREATE src/health/health.service.ts');
    expect(dry.output).toContain('(dry run: nothing written)');
    await expect(read('src/health/health.service.ts')).rejects.toThrow();
    expect(await read('src/app.module.ts')).toBe(before);
  });

  it('refuses to overwrite a file or to guess an invalid name', async () => {
    await scaffold('minimal');
    expect((await generate('g', 'service', 'billing')).code).toBe(0);
    const before = await read('src/app.module.ts');
    const again = await generate('g', 'service', 'billing');
    expect(again.code).toBe(1);
    expect(again.output).toContain('already exists');
    expect(await read('src/app.module.ts')).toBe(before);
    for (const name of ['../escape', '1st', 'two words', 'a/b']) {
      const invalid = await generate('g', 'service', name);
      expect(invalid.code).toBe(1);
      expect(invalid.output).toContain('Invalid name');
    }
    const unknown = await generate('g', 'gateway', 'chat');
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain('must be one of');
  });
});
