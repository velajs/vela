import { relative, sep } from 'node:path';
import { Command, Option, UsageError } from 'clipanion';
import {
  SCHEMATICS,
  planGeneration,
  writeGeneration,
  type Schematic,
} from '../generate/generate.js';

/** `vela generate <schematic> <name>` (alias `vela g`). */
export class GenerateCommand extends Command {
  static override paths = [['generate'], ['g']];
  static override usage = Command.Usage({
    category: 'Project',
    description:
      'Generate a module, controller, service, resource, queue, cron job, Durable Object, ' +
      'Workflow or service entrypoint.',
    details:
      'Writes the new files under src/<name>/ and registers them: a module or resource in the module ' +
      'of the directory above, a controller, service, cron job or queue processor in the module of ' +
      'its directory (else the nearest one up to the root module), QueueModule.registerQueue() next ' +
      'to a processor and QueueModule.forRoot({ driver: cloudflareQueues() }) in the root module ' +
      'once, and a Durable Object, Workflow or service entrypoint as an export of the Worker ' +
      'entry Wrangler names. A Workflow or service entrypoint runs in the Worker application, so ' +
      'an entry that default-exports createCloudflareWorker(AppModule) is given its app first ' +
      '(const app = defineCloudflareApp(AppModule)). Module files ' +
      'are edited in place with Oxc and magic-string; everything else in them is kept. ' +
      '--skip-import prints the registration instead. Existing files are never overwritten.',
    examples: [
      ['A CRUD resource', 'vela g resource notes'],
      ['A queue processor and its registration', 'vela g queue emails --binding EMAIL_QUEUE'],
      ['A cron job', 'vela g cron digest --schedule "30 6 * * MON"'],
      ['A Durable Object', 'vela g durable-object counter'],
      ['A Workflow', 'vela g workflow signup'],
      ['A service entrypoint (WorkerEntrypoint)', 'vela g entrypoint billing'],
      ['Register it yourself', 'vela g controller health --skip-import'],
    ],
  });

  schematic = Option.String({ name: 'schematic', required: true });
  name = Option.String({ name: 'name', required: true });
  sourcePath = Option.String('--path', { description: 'Source directory (default: src).' });
  module = Option.String('--module', { description: 'Module file to register in.' });
  flat = Option.Boolean('--flat', false, {
    description: 'Write into the source directory itself, not a directory named after the files.',
  });
  skipImport = Option.Boolean('--skip-import', false, {
    description: 'Do not edit modules; print the registration.',
  });
  dryRun = Option.Boolean('--dry-run', false, { description: 'Show the changes; write nothing.' });
  schedule = Option.String('--schedule', { description: 'cron: the Cloudflare cron expression.' });
  binding = Option.String('--binding', { description: 'queue: the Wrangler producer binding.' });

  async execute(): Promise<number> {
    const schematic = SCHEMATICS.find(
      (candidate): candidate is Schematic => candidate === this.schematic,
    );
    if (schematic === undefined) {
      throw new UsageError(`The schematic must be one of: ${SCHEMATICS.join(', ')}.`);
    }
    const cwd = process.cwd();
    let plan;
    try {
      plan = await planGeneration({
        schematic,
        name: this.name,
        cwd,
        path: this.sourcePath,
        module: this.module,
        flat: this.flat,
        skipImport: this.skipImport,
        schedule: this.schedule,
        binding: this.binding,
      });
      if (!this.dryRun) await writeGeneration(plan);
    } catch (error) {
      this.context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const display = (path: string) => relative(cwd, path).split(sep).join('/');
    for (const { path } of plan.creates) this.context.stdout.write(`CREATE ${display(path)}\n`);
    for (const { path } of plan.updates) this.context.stdout.write(`UPDATE ${display(path)}\n`);
    for (const note of plan.notes) this.context.stdout.write(`${note}\n`);
    if (this.dryRun) this.context.stdout.write('(dry run: nothing written)\n');
    return 0;
  }
}
