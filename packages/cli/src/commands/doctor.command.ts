import { describeToken } from '@velajs/vela/module-kit';
import type { VelaApplication } from '@velajs/vela';
import { Command, Option } from 'clipanion';
import { loadConfig, resolveConfig } from '../config.js';
import type { ConfigResolution } from '../config.js';
import { collectModules, collectRoutes } from '../introspect.js';
import { withApp } from '../with-app.js';

/** Read only app-owned description APIs; never resolve providers or serialize their values. */
function describeApplication(app: VelaApplication) {
  return {
    globalPrefix: app.getGlobalPrefix(),
    modules: collectModules(app),
    routes: collectRoutes(app),
    entrypoints: app.entrypoints.kinds().flatMap((kind) =>
      app.entrypoints.ofKind(kind).map((entry) => ({
        kind,
        target: `${describeToken(entry.token)}${entry.methodName === undefined ? '' : `#${String(entry.methodName)}`}`,
        ...('moduleId' in entry && typeof entry.moduleId === 'string'
          ? { moduleId: entry.moduleId }
          : {}),
      })),
    ),
  };
}

interface DoctorReport {
  schemaVersion: 1;
  cwd: string;
  nodeVersion: string;
  config: ConfigResolution | null;
  application?: ReturnType<typeof describeApplication>;
  issues: string[];
}

export class DoctorCommand extends Command {
  static override paths = [['doctor']];
  static override usage = Command.Usage({
    category: 'Introspection',
    description: 'Explain config resolution and optionally inspect the application graph.',
    details:
      'Checks config resolution without importing application code: a vela.config, or else the Worker entry the ' +
      'Wrangler file names. --app opts into import and application bootstrap, ' +
      'then reads app-local module, route and entrypoint snapshots and disposes the app. ' +
      'No files are written, providers are not resolved by the snapshot, and entrypoint metadata is omitted.',
    examples: [
      ['Explain config selection', 'vela doctor --json'],
      ['Inspect the app', 'vela doctor --app --config vela.config.ts --json'],
    ],
  });

  config = Option.String('--config', { description: 'Path to the Vela config file.' });
  environment = Option.String('--env', {
    description: 'Wrangler environment whose main and vars apply without a config.',
  });
  app = Option.Boolean('--app', false, {
    description: 'Import config, bootstrap the app and inspect its graph.',
  });
  json = Option.Boolean('--json', false, { description: 'Emit machine-readable diagnostics.' });

  async execute(): Promise<number> {
    const report: DoctorReport = {
      schemaVersion: 1,
      cwd: process.cwd(),
      nodeVersion: process.versions.node,
      config: null,
      issues: [],
    };
    try {
      report.config = await resolveConfig(report.cwd, this.config);
      if (this.app) {
        const loaded = await loadConfig(report.cwd, this.config, { environment: this.environment });
        report.application = await withApp(
          loaded,
          describeApplication,
          (message) => {
            report.issues.push(message);
          },
          this.context.stderr,
        );
      }
    } catch (error) {
      report.issues.push(error instanceof Error ? error.message : String(error));
    }

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      this.context.stdout.write(`Node ${report.nodeVersion}\nWorking directory: ${report.cwd}\n`);
      if (report.config) {
        this.context.stdout.write(`Config: ${report.config.path} (${report.config.source})\n`);
        for (const candidate of report.config.candidates)
          this.context.stdout.write(`  Checked: ${candidate}\n`);
      }
      if (report.application) {
        const { modules, routes, entrypoints } = report.application;
        this.context.stdout.write(
          `Application: ${modules.length} modules, ${routes?.length ?? 0} routes, ${entrypoints.length} entrypoints\n`,
        );
        this.context.stdout.write('Use --json for the full graph.\n');
      } else if (!this.app) {
        this.context.stdout.write(
          'Application code was not imported. Use --app to bootstrap and inspect the application.\n',
        );
      }
      for (const issue of report.issues) this.context.stderr.write(`${issue}\n`);
    }
    return report.issues.length ? 1 : 0;
  }
}
