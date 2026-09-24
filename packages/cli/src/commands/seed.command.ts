import { describeToken } from '@velajs/vela/module-kit';
import { runSeeders, SeederRegistry } from '@velajs/vela/seeder';
import { Command, Option, UsageError } from 'clipanion';
import { loadConfig } from '../config.js';
import { formatSeedResults, renderTable } from '../format.js';
import { withApp } from '../with-app.js';

/** `vela db seed` — build the app from vela.config and run its seeders. */
export class SeedCommand extends Command {
  static override paths = [['db', 'seed']];
  static override usage = Command.Usage({
    category: 'Database',
    description: 'Run database seeders for the Vela app.',
    details:
      'Builds the app from vela.config.{js,mjs,ts}, or else from the Worker entry the Wrangler file ' +
      "names with Wrangler's local bindings (getPlatformProxy, persisted like `vite dev`), and runs " +
      'all @Seeder() classes in order.',
    examples: [
      ['Run all seeders', 'vela db seed'],
      ['Use a specific config', 'vela db seed --config ./config/vela.config.js'],
      ['List seeders and their module owners', 'vela db seed --list --json'],
    ],
  });

  config = Option.String('--config', { description: 'Path to the vela config file.' });
  environment = Option.String('--env', {
    description: 'Wrangler environment whose bindings the seeders use without a config.',
  });
  continueOnError = Option.Boolean('--continue-on-error', false, {
    description: 'Run all seeders even if one fails.',
  });
  list = Option.Boolean('--list', false, {
    description: 'List registered seeders and their owners without running them.',
  });
  json = Option.Boolean('--json', false, { description: 'Emit --list inventory as JSON.' });

  async execute(): Promise<number> {
    if (this.json && !this.list) throw new UsageError('--json requires --list.');
    if (this.list && this.continueOnError)
      throw new UsageError('--list cannot be combined with --continue-on-error.');
    // Without a config, seeders write to the local bindings `vite dev` uses.
    const loaded = await loadConfig(process.cwd(), this.config, {
      environment: this.environment,
      bindings: 'local',
    });
    return withApp(
      loaded,
      async (app) => {
        if (this.list) {
          const inventory = app
            .get(SeederRegistry)
            .list()
            .map((seeder) => ({
              name: seeder.name,
              order: seeder.order,
              target: describeToken(seeder.target),
              moduleId: seeder.moduleId ?? null,
            }));
          const output = this.json
            ? JSON.stringify(inventory, null, 2)
            : renderTable(
                ['ORDER', 'NAME', 'MODULE', 'TARGET'],
                inventory.map((entry) => [
                  String(entry.order),
                  entry.name,
                  entry.moduleId ?? '(unknown)',
                  entry.target,
                ]),
              ).join('\n');
          this.context.stdout.write(`${output}\n`);
          return 0;
        }
        this.context.stdout.write('Running seeders…\n');
        const results = await runSeeders(app, { stopOnError: !this.continueOnError });
        return formatSeedResults(results, (message) => this.context.stdout.write(`${message}\n`));
      },
      (message) => this.context.stderr.write(`${message}\n`),
      this.context.stderr,
    );
  }
}
