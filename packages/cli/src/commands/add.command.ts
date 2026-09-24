import { Command, Option, UsageError } from 'clipanion';
import { RESOURCES, addResource, type Resource } from '../add.js';

/** `vela add <d1|kv|r2|queue> <BINDING>` — create a Cloudflare resource and wire it in. */
export class AddCommand extends Command {
  static override paths = [['add']];
  static override usage = Command.Usage({
    category: 'Project',
    description: 'Create a D1 database, KV namespace, R2 bucket or queue and register its binding.',
    details:
      "Runs the project's Wrangler to create the resource (d1/kv/r2 with --binding and --update-config, " +
      'which adds it to the Wrangler file; a queue with `wrangler queues create`, then its producer and ' +
      'consumer are added to wrangler.json(c) in place), regenerates the binding types, and registers ' +
      'it: a d1/kv/r2 binding as an injection token of a global BindingsModule next to the root module, ' +
      'a queue as QueueModule.registerQueue({ name, binding }) with the cloudflareQueues() driver in ' +
      'the root module. Creating a resource uses your Cloudflare account; log in with `wrangler login` first.',
    examples: [
      ['A D1 database bound as DB', 'vela add d1 DB'],
      ['A KV namespace with a chosen name', 'vela add kv CACHE --name shop-cache'],
      ['A queue', 'vela add queue EMAILS'],
    ],
  });

  resource = Option.String({ name: 'resource', required: true });
  binding = Option.String({ name: 'BINDING', required: true });
  name = Option.String('--name', {
    description: 'Cloudflare resource name (default: <worker>-<binding>).',
  });
  config = Option.String('--config', {
    description: 'Wrangler file (default: the one in the working directory).',
  });
  environment = Option.String('--env', { description: 'Named Wrangler environment.' });
  skipImport = Option.Boolean('--skip-import', false, {
    description: 'Do not edit modules; print the registration.',
  });

  async execute(): Promise<number> {
    const resource = RESOURCES.find(
      (candidate): candidate is Resource => candidate === this.resource,
    );
    if (resource === undefined) {
      throw new UsageError(`The resource must be one of: ${RESOURCES.join(', ')}.`);
    }
    try {
      await addResource({
        resource,
        binding: this.binding,
        cwd: process.cwd(),
        name: this.name,
        config: this.config,
        environment: this.environment,
        skipImport: this.skipImport,
        log: (line) => this.context.stdout.write(`${line}\n`),
      });
    } catch (error) {
      this.context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    return 0;
  }
}
