import { z } from 'zod';
import { parseWranglerText } from '../project/wrangler.js';

const record = z.record(z.string(), z.unknown());
const text = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value));
const bindingName = text.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u);
const workerName = text.max(255).regex(/^[a-zA-Z0-9-]+$/u);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });

/** Decode only data; parser errors deliberately omit configuration values. */
export function parseDeploymentConfig(source: string, path: string): unknown {
  return parseWranglerText(source, path);
}

function checked<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid Wrangler field: ${field}.`);
  return result.data;
}

export interface DeploymentBinding {
  readonly name: string;
  readonly kind: string;
}

/** A Wrangler `queues.producers` row: the binding and the physical queue it sends to. */
export interface DeploymentQueueProducer {
  readonly binding: string;
  readonly queue: string | undefined;
}

export interface DeploymentTarget {
  /** The named Wrangler environment, or null for the top-level configuration. */
  readonly environment: string | null;
  readonly worker: string;
  readonly main: string | null;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly crons: readonly string[];
  readonly bindings: readonly DeploymentBinding[];
  readonly queueProducers: readonly DeploymentQueueProducer[];
  readonly queueConsumers: readonly string[];
  /** Classes this Worker's own Durable Object bindings name (no `script_name`). */
  readonly durableObjectClasses: readonly string[];
  readonly customBuild: boolean;
}

/**
 * A projection, not a replacement for Wrangler's full configuration validator.
 * Without `environment`, the top-level configuration is the target.
 */
export function selectDeploymentTarget(raw: unknown, environment?: string): DeploymentTarget {
  if (environment !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(environment)) {
    throw new Error(
      'An environment name uses letters, digits, underscores or dashes, starting with a letter or digit.',
    );
  }
  const root = checked(record, raw, 'configuration');
  let selected = root;
  if (environment !== undefined) {
    const environments = checked(record, root.env, 'env');
    if (!Object.hasOwn(environments, environment))
      throw new Error('The requested environment is not declared in Wrangler configuration.');
    selected = checked(record, environments[environment], `env.${environment}`);
  }
  const inherit = (key: string): unknown =>
    Object.hasOwn(selected, key) ? selected[key] : root[key];
  // Wrangler appends the environment when the named environment omits name.
  const worker = checked(
    workerName,
    environment === undefined || Object.hasOwn(selected, 'name')
      ? selected.name
      : `${checked(workerName, root.name, 'name')}-${environment}`,
    'name',
  );
  const main = checked(text.optional(), inherit('main'), 'main') ?? null;
  if (main === null) {
    const assets = checked(record, inherit('assets'), 'assets (required without main)');
    checked(text, assets.directory, 'assets.directory');
  }
  const compatibilityDate = checked(date, inherit('compatibility_date'), 'compatibility_date');
  const compatibilityFlags =
    checked(z.array(text).optional(), inherit('compatibility_flags'), 'compatibility_flags') ?? [];
  const triggers = checked(
    z.object({ crons: z.array(text) }).optional(),
    inherit('triggers'),
    'triggers',
  );
  const build = checked(
    z.object({ command: text.optional() }).optional(),
    inherit('build'),
    'build',
  );
  const bindings: DeploymentBinding[] = [];
  const names = new Set<string>();
  const add = (name: string, kind: string): void => {
    if (names.has(name)) throw new Error(`Duplicate Worker binding name: ${name}.`);
    names.add(name);
    bindings.push({ name, kind });
  };
  // Resource bindings and vars are NOT inherited by a named environment.
  const variables = checked(record.optional(), selected.vars, 'vars') ?? {};
  for (const name of Object.keys(variables))
    add(checked(bindingName, name, 'vars binding name'), 'var');
  for (const kind of [
    'kv_namespaces',
    'd1_databases',
    'r2_buckets',
    'services',
    'hyperdrive',
    'vectorize',
    'workflows',
    'analytics_engine_datasets',
  ]) {
    const rows = checked(z.array(record).optional(), selected[kind], kind) ?? [];
    for (const row of rows) {
      add(checked(bindingName, row.binding, `${kind}.binding`), kind);
      // Omitted IDs are supported by Wrangler auto-provisioning. Never print IDs/values.
      for (const field of ['id', 'database_id', 'database_name', 'bucket_name']) {
        if (Object.hasOwn(row, field)) checked(text, row[field], `${kind}.${field}`);
      }
      if (kind === 'services') checked(workerName, row.service, 'services.service');
      if (kind === 'workflows') checked(text, row.class_name, 'workflows.class_name');
    }
  }
  const durable = checked(
    z
      .object({
        bindings: z.array(
          z.object({
            name: bindingName,
            class_name: text,
            script_name: workerName.optional(),
          }),
        ),
      })
      .optional(),
    selected.durable_objects,
    'durable_objects',
  );
  for (const row of durable?.bindings ?? []) add(row.name, 'durable_objects');
  const queues = checked(
    z
      .object({
        producers: z.array(z.object({ binding: bindingName, queue: text.optional() })).optional(),
        consumers: z.array(z.object({ queue: text })).optional(),
      })
      .optional(),
    selected.queues,
    'queues',
  );
  const queueProducers = (queues?.producers ?? []).map(({ binding, queue }) => {
    add(binding, 'queues');
    return { binding, queue };
  });
  const queueConsumers = queues?.consumers?.map((row) => row.queue) ?? [];
  if (new Set(queueConsumers).size !== queueConsumers.length)
    throw new Error('Duplicate queue consumer configuration.');
  return {
    environment: environment ?? null,
    worker,
    main,
    compatibilityDate,
    compatibilityFlags,
    crons: triggers?.crons ?? [],
    bindings,
    queueProducers,
    queueConsumers,
    durableObjectClasses: (durable?.bindings ?? [])
      .filter((row) => row.script_name === undefined)
      .map((row) => row.class_name),
    customBuild: build?.command !== undefined,
  };
}
