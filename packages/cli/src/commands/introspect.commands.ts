import { writeFile } from 'node:fs/promises';
import { createOpenApiDocument } from '@velajs/vela';
import type { VelaApplication } from '@velajs/vela';
import { Command, Option } from 'clipanion';
import { loadConfig } from '../config.js';
import { renderTable } from '../format.js';
import {
  collectEntrypoints,
  collectModules,
  collectRoutes,
  renderModuleTree,
} from '../introspect.js';

/** Shared shell: load config → createApp → run → best-effort dispose. */
abstract class AppCommand extends Command {
  config = Option.String('--config', { description: 'Path to the vela config file.' });
  json = Option.Boolean('--json', false, { description: 'Emit machine-readable JSON.' });

  protected abstract run(app: VelaApplication): Promise<number>;

  async execute(): Promise<number> {
    const velaConfig = await loadConfig(process.cwd(), this.config);
    const app = await velaConfig.createApp();
    try {
      return await this.run(app);
    } finally {
      const dispose = (app as { dispose?: () => Promise<void> }).dispose;
      if (typeof dispose === 'function') {
        try {
          await dispose.call(app);
        } catch (error) {
          this.context.stderr.write(`Warning: teardown failed: ${String(error)}\n`);
        }
      }
    }
  }

  protected print(text: string): void {
    this.context.stdout.write(`${text}\n`);
  }
}

/** `vela route list` — the app's HTTP route table. */
export class RouteListCommand extends AppCommand {
  static override paths = [['route', 'list']];
  static override usage = Command.Usage({
    category: 'Introspection',
    description: 'List the HTTP routes of the Vela app.',
    details:
      'Framework-composed controller routes (method, full path, controller#handler) plus ' +
      'everything else mounted on the router (CRUD/contributed routes, doc UIs) labeled (mounted).',
    examples: [
      ['List routes', 'vela route list'],
      ['As JSON', 'vela route list --json'],
    ],
  });

  protected async run(app: VelaApplication): Promise<number> {
    const rows = collectRoutes(app);
    if (rows === null) {
      this.print('This app builds no HTTP routes — nothing to list.');
      return 0;
    }
    if (this.json) {
      this.print(JSON.stringify(rows, null, 2));
      return 0;
    }
    for (const line of renderTable(
      ['METHOD', 'PATH', 'HANDLER'],
      rows.map((r) => [r.method, r.path, r.handler]),
    )) {
      this.print(line);
    }
    return 0;
  }
}

/** `vela module graph` — the loaded module graph. */
export class ModuleGraphCommand extends AppCommand {
  static override paths = [['module', 'graph']];
  static override usage = Command.Usage({
    category: 'Introspection',
    description: 'Print the module graph of the Vela app.',
    details:
      'Module instances with their imports (indented tree), global/lazy flags, and provider ' +
      'counts. --json emits the raw descriptions (providers, exports, imports per module).',
    examples: [
      ['Print the graph', 'vela module graph'],
      ['As JSON', 'vela module graph --json'],
    ],
  });

  protected async run(app: VelaApplication): Promise<number> {
    const modules = collectModules(app);
    if (this.json) {
      this.print(JSON.stringify(modules, null, 2));
      return 0;
    }
    for (const line of renderModuleTree(modules)) this.print(line);
    return 0;
  }
}

/** `vela entrypoint list` — declared entrypoint kinds and their entries. */
export class EntrypointListCommand extends AppCommand {
  static override paths = [['entrypoint', 'list']];
  static override usage = Command.Usage({
    category: 'Introspection',
    description: 'List entrypoint kinds and entries (websocket, queue, cron, …).',
    details:
      'Every declared kind — including kinds with zero entries — with the contributing ' +
      'class (and method for method-level kinds) and its metadata.',
    examples: [['List entrypoints', 'vela entrypoint list']],
  });

  protected async run(app: VelaApplication): Promise<number> {
    const rows = collectEntrypoints(app);
    if (this.json) {
      this.print(JSON.stringify(rows, null, 2));
      return 0;
    }
    for (const line of renderTable(
      ['KIND', 'TARGET', 'META'],
      rows.map((r) => [r.kind, r.target, r.meta]),
    )) {
      this.print(line);
    }
    return 0;
  }
}

/** `vela openapi dump` — emit the OpenAPI document. */
export class OpenApiDumpCommand extends Command {
  static override paths = [['openapi', 'dump']];
  static override usage = Command.Usage({
    category: 'Introspection',
    description: 'Emit the OpenAPI document for the Vela app.',
    details:
      'Requires `rootModule` in vela.config (createOpenApiDocument works from the module ' +
      "class). The app's global prefix is applied automatically; --global-prefix overrides.",
    examples: [
      ['Print to stdout', 'vela openapi dump'],
      ['Write to a file', 'vela openapi dump --out openapi.json'],
    ],
  });

  config = Option.String('--config', { description: 'Path to the vela config file.' });
  out = Option.String('--out', {
    description: 'Write the document to this file instead of stdout.',
  });
  title = Option.String('--title', { description: 'info.title override.' });
  apiVersion = Option.String('--api-version', { description: 'info.version override.' });
  globalPrefix = Option.String('--global-prefix', {
    description: "Path prefix override (defaults to the app's global prefix).",
  });

  async execute(): Promise<number> {
    const velaConfig = await loadConfig(process.cwd(), this.config);
    if (!velaConfig.rootModule) {
      this.context.stderr.write(
        'openapi dump needs the root module. Add it to your vela.config:\n\n' +
          '  export default defineVelaConfig({\n' +
          '    rootModule: AppModule,\n' +
          '    async createApp() { ... },\n' +
          '  });\n',
      );
      return 1;
    }

    const app = await velaConfig.createApp();
    try {
      const info: Record<string, string> = {};
      if (this.title) info.title = this.title;
      if (this.apiVersion) info.version = this.apiVersion;

      const document = createOpenApiDocument(velaConfig.rootModule, {
        globalPrefix: this.globalPrefix ?? app.getGlobalPrefix(),
        ...(Object.keys(info).length > 0 ? { info } : {}),
      });

      const text = JSON.stringify(document, null, 2);
      if (this.out) {
        await writeFile(this.out, `${text}\n`, 'utf8');
        this.context.stdout.write(`Wrote ${this.out}\n`);
      } else {
        this.context.stdout.write(`${text}\n`);
      }
      return 0;
    } finally {
      const dispose = (app as { dispose?: () => Promise<void> }).dispose;
      if (typeof dispose === 'function') {
        try {
          await dispose.call(app);
        } catch (error) {
          this.context.stderr.write(`Warning: teardown failed: ${String(error)}\n`);
        }
      }
    }
  }
}
