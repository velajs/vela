import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { Command, Option } from 'clipanion';
import { applyCloudflareSync, planCloudflareSync, type CloudflareFacts } from '../cf-sync.js';
import { loadConfig } from '../config.js';
import { collectEntrypoints } from '../introspect.js';
import { classifyWorkerExports } from '../project/worker-entry.js';
import { findWranglerConfig, readWranglerConfig, wranglerMain } from '../project/wrangler.js';
import { withApp } from '../with-app.js';

/** `vela cf sync` — compare (or update) the Wrangler file with what the application declares. */
export class CloudflareSyncCommand extends Command {
  static override paths = [['cf', 'sync']];
  static override usage = Command.Usage({
    category: 'Deployment',
    description: 'Compare the Wrangler configuration with the application, or update it.',
    details:
      'Builds the application (vela.config, or else the Worker entry the Wrangler file names, with ' +
      'its `vars` only) and derives the configuration it needs: a cron trigger per @Cron ' +
      'expression, a queue producer per QueueModule.registerQueue({ binding }), a consumer per ' +
      'processed or @QueueConsumer queue, and a binding, migration and Workflow entry for every ' +
      'Durable Object and Workflow class the Worker entry exports. By default it prints the ' +
      'differences and exits 1 when there are any. --write applies them to wrangler.json(c) in ' +
      'place, keeping comments; a wrangler.toml is only compared. Cron triggers no @Cron job ' +
      'declares are removed; anything else the application does not use is reported, never deleted.',
    examples: [
      ['Compare', 'vela cf sync'],
      ['Update wrangler.jsonc', 'vela cf sync --write'],
      ['Update the staging environment', 'vela cf sync --env staging --write'],
    ],
  });

  config = Option.String('--config', {
    description: 'Wrangler .json/.jsonc/.toml file (default: the one in the working directory).',
  });
  environment = Option.String('--env', {
    description: 'Named Wrangler environment (default: the top-level configuration).',
  });
  write = Option.Boolean('--write', false, { description: 'Apply the changes to the file.' });
  json = Option.Boolean('--json', false, { description: 'Emit the plan as JSON.' });

  async execute(): Promise<number> {
    let path: string;
    if (this.config === undefined) {
      const found = await findWranglerConfig(process.cwd());
      if (found.path === undefined) {
        this.context.stderr.write(
          `No Wrangler configuration found (checked ${found.candidates.join(', ')}). Pass --config <file>.\n`,
        );
        return 1;
      }
      path = found.path;
    } else {
      path = resolve(this.config);
    }
    const wrangler = await readWranglerConfig(path);
    if (this.write && wrangler.format === 'toml') {
      this.context.stderr.write(
        `vela cf sync --write edits wrangler.json and wrangler.jsonc files; update ${basename(path)} by hand ` +
          '(run without --write to list the changes).\n',
      );
      return 1;
    }
    const main = wranglerMain(wrangler, this.environment);
    const loaded = await loadConfig(dirname(path), undefined, {
      environment: this.environment,
      wrangler: path,
    });
    const facts: CloudflareFacts = await withApp(
      loaded,
      async (app) => ({
        entrypoints: collectEntrypoints(app),
        exports: await classifyWorkerExports(await loaded.importModule(main), loaded.importModule),
      }),
      (message) => this.context.stderr.write(`${message}\n`),
    );
    const plan = planCloudflareSync(wrangler, this.environment, facts);
    const status = plan.changes.length === 0 ? 'in-sync' : this.write ? 'written' : 'out-of-sync';
    if (status === 'written') {
      await writeFile(path, applyCloudflareSync(wrangler.text, plan.changes), 'utf8');
    }

    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify(
          {
            status,
            config: path,
            environment: this.environment ?? null,
            changes: plan.changes.map(({ path: key, value, append }) => ({
              path: key,
              value,
              append,
            })),
            warnings: plan.warnings,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const file = basename(path);
      if (status === 'in-sync') {
        this.context.stdout.write(`${file} matches the application.\n`);
      } else {
        this.context.stdout.write(
          `${status === 'written' ? 'Updated' : 'Differences in'} ${file}:\n` +
            plan.changes.map((change) => `${change.summary.replaceAll(/^/gm, '  ')}\n`).join(''),
        );
      }
      for (const warning of plan.warnings) this.context.stdout.write(`Warning: ${warning}\n`);
      if (status === 'out-of-sync') {
        this.context.stdout.write(`Run vela cf sync --write to apply the changes.\n`);
      } else if (status === 'written') {
        this.context.stdout.write(
          'Run `wrangler types` (your types script) to refresh worker-configuration.d.ts.\n',
        );
      }
    }
    return status === 'out-of-sync' ? 1 : 0;
  }
}
