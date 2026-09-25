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
      '    TodosModule,\n    CategoriesModule,\n  ],',
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

  it('writes nothing when a spread in the module metadata may hold the list', async () => {
    await scaffold('minimal');
    const app = `import { Module } from '@velajs/vela';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

const jobs = { providers: [AppService] };

@Module({ ...jobs, controllers: [AppController] })
export class AppModule {}
`;
    await writeFile(join(project, 'src/app.module.ts'), app);
    for (const [schematic, key] of [
      ['service', 'providers'],
      ['module', 'imports'],
    ]) {
      const result = await generate('g', schematic, 'billing');
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(
        `src/app.module.ts: a spread or computed key in @Module() may set ${key}; register`,
      );
    }
    expect(await read('src/app.module.ts')).toBe(app);
    await expect(readdir(join(project, 'src/billing'))).rejects.toThrow();
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
    expect(result.output).toContain('CREATE src/counter/counter.host.ts');
    const host = await read('src/counter/counter.host.ts');
    expect(host).toContain('@Injectable()\nexport class CounterHost {');
    expect(host).toContain(
      'constructor(@Inject(DO_STORAGE) private readonly storage: DurableObjectStorage) {}',
    );
    expect(await read('src/counter/counter.durable-object.ts'))
      .toBe(`import { VelaDurableObject } from '@velajs/cloudflare/durable-objects';
import { AppModule } from '../app.module.js';
import { CounterHost } from './counter.host.js';

// Each instance boots AppModule with CounterHost as one of its providers. The
// host methods rpc names are this class's RPC methods, and the host's guards,
// pipes, interceptors and filters run around every call.
export class Counter extends VelaDurableObject(AppModule, CounterHost, {
  rpc: ['increment'],
}) {}
`);
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

  it('defines a Durable Object from the app the Worker entry binds', async () => {
    await scaffold('minimal');
    const entry = `import { defineCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';
import { reporting } from './reporting.js';

// The app: its Worker and its Durable Object classes share the adapters.
const app = defineCloudflareApp(AppModule, { adapters: [reporting] });

// The Worker's handlers.
export default app.worker;
`;
    await writeFile(join(project, 'src/worker.ts'), entry);
    const result = await generate('g', 'durable-object', 'ledger');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('CREATE src/ledger/ledger.host.ts');
    expect(result.output).toContain('UPDATE src/worker.ts');
    // The class uses the app, so it lives beside it: a separate file importing
    // the entry would run before the entry defined the app.
    await expect(read('src/ledger/ledger.durable-object.ts')).rejects.toThrow();
    expect(await read('src/worker.ts'))
      .toBe(`import { defineCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';
import { reporting } from './reporting.js';
import { VelaDurableObject } from '@velajs/cloudflare/durable-objects';
import { LedgerHost } from './ledger/ledger.host.js';

// The app: its Worker and its Durable Object classes share the adapters.
const app = defineCloudflareApp(AppModule, { adapters: [reporting] });

// Each instance boots app, configured by its runtime adapters, with LedgerHost
// as one of its providers. The host methods rpc names are this class's RPC
// methods, and the host's guards, pipes, interceptors and filters run around
// every call.
export class Ledger extends VelaDurableObject(app, LedgerHost, {
  rpc: ['increment'],
}) {}

// The Worker's handlers.
export default app.worker;
`);
  });

  it('imports the app a Worker entry imports into a new Durable Object', async () => {
    await scaffold('minimal');
    await writeFile(
      join(project, 'src/app.ts'),
      `import { defineCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

export const app = defineCloudflareApp(AppModule);
`,
    );
    await writeFile(
      join(project, 'src/worker.ts'),
      `import { app } from './app.js';

export default app.worker;
`,
    );
    const result = await generate('g', 'durable-object', 'ledger');
    expect(result.code, result.output).toBe(0);
    expect(await read('src/ledger/ledger.durable-object.ts'))
      .toBe(`import { VelaDurableObject } from '@velajs/cloudflare/durable-objects';
import { app } from '../app.js';
import { LedgerHost } from './ledger.host.js';

// Each instance boots app, configured by its runtime adapters, with LedgerHost
// as one of its providers. The host methods rpc names are this class's RPC
// methods, and the host's guards, pipes, interceptors and filters run around
// every call.
export class Ledger extends VelaDurableObject(app, LedgerHost, {
  rpc: ['increment'],
}) {}
`);
    expect(await read('src/worker.ts')).toBe(`import { app } from './app.js';
export { Ledger } from './ledger/ledger.durable-object.js';

export default app.worker;
`);
  });

  it('says when a new Durable Object cannot share the options of an unnamed app', async () => {
    await scaffold('minimal');
    await writeFile(
      join(project, 'src/worker.ts'),
      `import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';
import { reporting } from './reporting.js';

export default createCloudflareWorker(AppModule, { adapters: [reporting] });
`,
    );
    const result = await generate('g', 'durable-object', 'ledger');
    expect(result.code, result.output).toBe(0);
    expect(await read('src/ledger/ledger.durable-object.ts')).toContain(
      'export class Ledger extends VelaDurableObject(AppModule, LedgerHost, {',
    );
    expect(result.output).toContain(
      'Ledger is built from the bare root module AppModule, so the options the Worker entry ' +
        'passes to createCloudflareWorker(), such as its runtime adapters, do not configure it.',
    );
    expect(result.output).toContain('const app = defineCloudflareApp(AppModule, options)');
  });

  it('prints the Durable Object declaration an app-bound entry needs with --skip-import', async () => {
    await scaffold('minimal');
    const entry = `import { defineCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

const app = defineCloudflareApp(AppModule);
export default app.worker;
`;
    await writeFile(join(project, 'src/worker.ts'), entry);
    const result = await generate('g', 'durable-object', 'ledger', '--skip-import');
    expect(result.code, result.output).toBe(0);
    expect(await read('src/worker.ts')).toBe(entry);
    expect(result.output).toContain(
      "Declare it in the Worker entry src/worker.ts, after app: import { VelaDurableObject } from '@velajs/cloudflare/durable-objects'; import { LedgerHost } from './ledger/ledger.host.js'; export class Ledger extends VelaDurableObject(app, LedgerHost, { rpc: ['increment'] }) {}",
    );
  });

  it('defines the app in a createCloudflareWorker() entry and declares a Workflow from it', async () => {
    await scaffold('minimal');
    const result = await generate('g', 'workflow', 'signup');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('CREATE src/signup/signup.host.ts');
    expect(result.output).toContain('UPDATE src/worker.ts');
    const host = await read('src/signup/signup.host.ts');
    expect(host).toContain(
      "import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';",
    );
    expect(host).toContain('export interface SignupParams {');
    expect(host).toContain('@Injectable()\nexport class SignupHost {');
    expect(host).toContain(
      '  async run(\n    event: WorkflowEvent<SignupParams>,\n    step: WorkflowStep,\n  ): Promise<',
    );
    // A Workflow runs in the Worker's application, so the entry binds its app.
    expect(await read('src/worker.ts'))
      .toBe(`import { defineCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';
import { VelaWorkflow } from '@velajs/cloudflare/workflows';
import { SignupHost } from './signup/signup.host.js';

const app = defineCloudflareApp(AppModule);

// Each run executes SignupHost.run(event, step) in the application app builds
// for the run's environment, the one the Worker's handlers use.
export class Signup extends VelaWorkflow(app, SignupHost) {}

export default app.worker;
`);
    expect(result.output).toContain(
      'Next: vela cf sync --write adds the SIGNUP Workflow binding, and your types script types ENV.SIGNUP.',
    );
  });

  it('declares a service entrypoint after the app the Worker entry binds', async () => {
    await scaffold('minimal');
    await writeFile(
      join(project, 'src/worker.ts'),
      `import { defineCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

const app = defineCloudflareApp(AppModule, { globalPrefix: '/api' });

export default app.worker;
`,
    );
    const result = await generate('g', 'entrypoint', 'billing');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('CREATE src/billing/billing.host.ts');
    const host = await read('src/billing/billing.host.ts');
    expect(host).toContain('@Injectable()\nexport class BillingHost {');
    expect(host).toContain('ping(message: string)');
    expect(await read('src/worker.ts'))
      .toBe(`import { defineCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';
import { VelaEntrypoint } from '@velajs/cloudflare/entrypoints';
import { BillingHost } from './billing/billing.host.js';

const app = defineCloudflareApp(AppModule, { globalPrefix: '/api' });

// Each call runs in the application app builds for its environment, the one
// the Worker's handlers use. The host methods rpc names are this entrypoint's
// RPC methods; the host's guards, pipes, interceptors and filters run around
// every call.
export class Billing extends VelaEntrypoint(app, BillingHost, {
  rpc: ['ping'],
}) {}

export default app.worker;
`);
    expect(result.output).toContain(
      "Next: bind it from another Worker (or this one) with services: [{ binding: 'BILLING', service: 'demo', entrypoint: 'Billing' }], and call env.BILLING.ping().",
    );
  });

  it('writes a Workflow file importing the app a Worker entry imports', async () => {
    await scaffold('minimal');
    await writeFile(
      join(project, 'src/app.ts'),
      `import { defineCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

export const app = defineCloudflareApp(AppModule);
`,
    );
    await writeFile(
      join(project, 'src/worker.ts'),
      `import { app } from './app.js';\n\nexport default app.worker;\n`,
    );
    const result = await generate('g', 'workflow', 'report');
    expect(result.code, result.output).toBe(0);
    expect(await read('src/report/report.workflow.ts'))
      .toBe(`import { VelaWorkflow } from '@velajs/cloudflare/workflows';
import { app } from '../app.js';
import { ReportHost } from './report.host.js';

// Each run executes ReportHost.run(event, step) in the application app builds
// for the run's environment, the one the Worker's handlers use.
export class Report extends VelaWorkflow(app, ReportHost) {}
`);
    expect(await read('src/worker.ts')).toBe(`import { app } from './app.js';
export { Report } from './report/report.workflow.js';

export default app.worker;
`);
  });

  it('prints the entrypoint declaration and the app definition with --skip-import', async () => {
    await scaffold('minimal');
    const entry = await read('src/worker.ts');
    const result = await generate('g', 'entrypoint', 'billing', '--skip-import');
    expect(result.code, result.output).toBe(0);
    expect(await read('src/worker.ts')).toBe(entry);
    expect(result.output).toContain(
      'Define the app in the Worker entry src/worker.ts: const app = defineCloudflareApp(AppModule); export default app.worker;',
    );
    expect(result.output).toContain(
      "Declare it in the Worker entry src/worker.ts, after app: import { VelaEntrypoint } from '@velajs/cloudflare/entrypoints'; import { BillingHost } from './billing/billing.host.js'; export class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['ping'] }) {}",
    );
  });

  it('explains a Worker entry whose app it cannot define', async () => {
    await scaffold('minimal');
    await writeFile(
      join(project, 'src/worker.ts'),
      `import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

const worker = createCloudflareWorker(AppModule);
export default { ...worker, async email() {} };
`,
    );
    const result = await generate('g', 'workflow', 'signup');
    expect(result.code).toBe(1);
    expect(result.output).toContain('defineCloudflareApp(AppModule, options)');
    await expect(read('src/signup/signup.host.ts')).rejects.toThrow();
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
