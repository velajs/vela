import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createOpenApiDocument } from '@velajs/vela/openapi';
import type { OpenApiDocument } from '@velajs/vela/openapi';
import { Command, Option } from 'clipanion';
import { generateClientContract } from '../client-contract.js';
import { loadConfig } from '../config.js';
import { withApp } from '../with-app.js';

/** The HTTP methods an OpenAPI path item can describe. */
const OPENAPI_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

export class ClientGenerateCommand extends Command {
  static override paths = [['client', 'generate']];
  static override usage = Command.Usage({
    category: 'Client',
    description: "Generate a typed HTTP contract for Hono's hc client.",
    details:
      'Builds the app (vela.config with rootModule, or else the Worker entry the Wrangler file names; --env selects a Wrangler environment), or reads an OpenAPI JSON file with --input. Missing schemas emit unknown and a warning; --strict makes those warnings an error.',
    examples: [
      ['Generate from an app', 'vela client generate --out src/api.generated.ts'],
      [
        'Generate from a document',
        'vela client generate --input openapi.json --out src/api.generated.ts',
      ],
      ['Check a committed contract', 'vela client generate --out src/api.generated.ts --check'],
    ],
  });

  config = Option.String('--config', { description: 'Path to the vela config file.' });
  environment = Option.String('--env', {
    description: 'Wrangler environment whose main and vars apply without a config.',
  });
  input = Option.String('--input', {
    description: 'Read an OpenAPI JSON file without bootstrapping the app.',
  });
  out = Option.String('--out', { description: 'Output TypeScript file (stdout when omitted).' });
  check = Option.Boolean('--check', false, {
    description: 'Fail if --out differs from the generated contract; do not write.',
  });
  strict = Option.Boolean('--strict', false, { description: 'Fail on missing or lossy schemas.' });

  async execute(): Promise<number> {
    if (this.input && (this.config || this.environment))
      throw new Error('Use either --input or --config/--env, not both.');
    if (this.check && !this.out) throw new Error('--check requires --out.');
    const document = this.input ? await this.#readDocument(this.input) : await this.#fromApp();
    const { source, warnings } = generateClientContract(document);
    for (const warning of warnings) this.context.stderr.write(`Warning: ${warning}\n`);
    if (this.strict && warnings.length) return 1;
    if (this.check) {
      let existing: string | undefined;
      try {
        existing = await readFile(this.out!, 'utf8');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      if (existing !== source) {
        this.context.stderr.write(
          `Client contract is missing or stale: ${this.out}. Run vela client generate without --check.\n`,
        );
        return 1;
      }
    } else if (this.out) {
      await mkdir(dirname(this.out), { recursive: true });
      await writeFile(this.out, source, 'utf8');
      this.context.stdout.write(`Wrote ${this.out}\n`);
    } else {
      this.context.stdout.write(source);
    }
    return 0;
  }

  async #readDocument(file: string): Promise<unknown> {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    // generateClientContract validates the complete consumed projection for
    // both file inputs and documents produced by the running application.
    return value;
  }

  async #fromApp(): Promise<OpenApiDocument> {
    const loaded = await loadConfig(process.cwd(), this.config, {
      environment: this.environment,
    });
    const rootModule = loaded.config.rootModule;
    if (!rootModule) {
      await loaded.dispose();
      throw new Error(
        'client generate needs rootModule in vela.config, or pass --input openapi.json.',
      );
    }
    return withApp(
      loaded,
      async (app) => {
        const document = createOpenApiDocument(rootModule, {
          globalPrefix: app.getGlobalPrefix(),
        });
        // Detect older Vela exporters which omit versioned controller routes.
        // Never silently ship a contract which points at a different endpoint.
        for (const route of app.describeRoutes()) {
          // An @All handler (such as a mounted auth handler) has no OpenAPI operation.
          if (!OPENAPI_METHODS.has(route.method.toLowerCase())) continue;
          const path = route.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
          const item = document.paths[path];
          if (!item || !Object.hasOwn(item, route.method.toLowerCase())) {
            throw new Error(
              `OpenAPI is missing ${route.method} ${route.path}. Update Vela or pass a complete document with --input.`,
            );
          }
        }
        return document;
      },
      (message) => this.context.stderr.write(`${message}\n`),
      this.context.stderr,
    );
  }
}
