import { runSeeders } from '@velajs/vela/seeder';
import { Command, Option } from 'clipanion';
import { loadConfig } from '../config.js';
import { formatSeedResults } from '../format.js';
import { withApp } from '../with-app.js';

/** `vela db seed` — build the app from vela.config and run its seeders. */
export class SeedCommand extends Command {
  static override paths = [['db', 'seed']];
  static override usage = Command.Usage({
    category: 'Database',
    description: 'Run database seeders for the Vela app.',
    details:
      'Loads vela.config.{js,mjs,ts}, builds the app, and runs all @Seeder() classes in order.',
    examples: [
      ['Run all seeders', 'vela db seed'],
      ['Use a specific config', 'vela db seed --config ./config/vela.config.js'],
    ],
  });

  config = Option.String('--config', { description: 'Path to the vela config file.' });
  continueOnError = Option.Boolean('--continue-on-error', false, {
    description: 'Run all seeders even if one fails.',
  });

  async execute(): Promise<number> {
    const config = await loadConfig(process.cwd(), this.config);
    return withApp(
      config,
      async (app) => {
        this.context.stdout.write('Running seeders…\n');
        const results = await runSeeders(app, { stopOnError: !this.continueOnError });
        return formatSeedResults(results, (message) => this.context.stdout.write(`${message}\n`));
      },
      (message) => this.context.stderr.write(`${message}\n`),
    );
  }
}
