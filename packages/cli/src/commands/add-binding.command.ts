import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command, Option } from 'clipanion';
import { applyEdits, modify } from 'jsonc-parser';
import { refreshTypes } from '../add.js';
import { applyCloudflareSync } from '../cf-sync.js';
import { BINDING_DEFINITIONS, bindingDeclaration, bindingInventory } from '../project/bindings.js';
import {
  environmentSection,
  findWranglerConfig,
  parseWranglerText,
  readWranglerConfig,
} from '../project/wrangler.js';
import { isRecord } from '../project/files.js';

/** Config-only declarations: resource creation and account setup remain explicit. */
export class AddBindingCommand extends Command {
  static override paths = [['add', 'binding']];
  static override usage = Command.Usage({
    category: 'Project',
    description:
      'Declare a native Wrangler binding without provisioning resources or editing modules.',
    details:
      'Use a Wrangler key (for example flagship, ai, secrets_store_secrets or queues.producers). ' +
      '--options is a JSON object of resource identifiers and settings, excluding the binding name. ' +
      'Edits JSON/JSONC in place, preserves unknown settings and refreshes types with the selected environment. ' +
      'TOML is left unchanged and requires a manual edit. No resources, permissions, consumers or migrations are created. ' +
      'Wrangler owns full deployment validation; the declaration does not prove a resource exists.',
    examples: [
      [
        'Declare a Flagship application',
        `vela add binding flagship FLAGS --options '{"app_id":"example-app"}'`,
      ],
      ['Declare Workers AI', 'vela add binding ai AI'],
    ],
  });
  kind = Option.String({ name: 'kind', required: true });
  binding = Option.String({ name: 'BINDING', required: true });
  options = Option.String('--options', '{}', {
    description: 'JSON object of native Wrangler fields.',
  });
  config = Option.String('--config', { description: 'Wrangler config file.' });
  environment = Option.String('--env', { description: 'Named Wrangler environment.' });

  async execute(): Promise<number> {
    try {
      const definition = BINDING_DEFINITIONS.find(
        (entry) =>
          entry.path.join('.') === this.kind &&
          ['array', 'object'].includes(entry.shape) &&
          !['unsafe', 'unsafe_hello_world', 'logfwdr'].includes(entry.path[0] ?? ''),
      );
      if (definition === undefined)
        throw new Error(
          'Unsupported declaration kind. Use a native Wrangler binding key such as flagship, ai, secrets_store_secrets or queues.producers.',
        );
      let options: unknown;
      try {
        options = JSON.parse(this.options);
      } catch {
        throw new Error('--options must be a JSON object.');
      }
      const value = bindingDeclaration(definition, this.binding, options);
      const cwd = process.cwd();
      const path =
        this.config === undefined
          ? (await findWranglerConfig(cwd)).path
          : resolve(cwd, this.config);
      if (path === undefined)
        throw new Error('No Wrangler configuration found; pass --config <file>.');
      const config = await readWranglerConfig(path);
      const section = environmentSection(config, this.environment);
      const inventory = bindingInventory(config.root, section);
      if (inventory.some((entry) => entry.name === this.binding))
        throw new Error(`${this.binding} is already a binding in the selected environment.`);
      // A singleton must never silently replace an existing binding (including inherited assets).
      if (
        definition.shape === 'object' &&
        (Object.hasOwn(section, this.kind) ||
          (definition.inherited && Object.hasOwn(config.root, this.kind)))
      ) {
        throw new Error(
          `${this.kind} is already configured; edit its binding explicitly in Wrangler configuration.`,
        );
      }
      if (config.format === 'toml') {
        this.context.stdout.write(
          `Manual edit required: declare ${this.binding} under ${this.environment === undefined ? '' : `env.${this.environment}.`}${this.kind} using the supplied --options, then run wrangler types for that configuration and environment. No files or resources were changed.\n`,
        );
        return 2;
      }
      const configPath = [
        ...(this.environment === undefined ? [] : ['env', this.environment]),
        ...definition.path,
      ];
      const updated =
        definition.shape === 'array'
          ? applyCloudflareSync(config.text, [
              { path: configPath, value, op: 'append', summary: '' },
            ])
          : applyEdits(
              config.text,
              modify(config.text, configPath, value, {
                formattingOptions: { insertSpaces: true, tabSize: 2 },
              }),
            );
      const raw = parseWranglerText(updated, path);
      if (!isRecord(raw)) throw new Error('Invalid edited Wrangler configuration.');
      const next = bindingInventory(
        raw,
        environmentSection({ ...config, root: raw }, this.environment),
      );
      if (!next.some((entry) => entry.name === this.binding))
        throw new Error('Could not declare the binding; no files were changed.');
      await writeFile(path, updated, 'utf8');
      this.context.stdout.write(
        `Declared ${this.binding} under ${this.kind}. No resources were provisioned; configure the referenced resource and its permissions separately.\n`,
      );
      await refreshTypes(
        dirname(path),
        (await findWranglerConfig(dirname(path))).path === path ? undefined : path,
        (line) => this.context.stdout.write(`${line}\n`),
        this.environment,
      );
      return 0;
    } catch (error) {
      this.context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
}
