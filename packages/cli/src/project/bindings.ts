import { z } from 'zod';

const text = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value));
const name = text.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u);
const worker = text.max(255).regex(/^[a-zA-Z0-9-]+$/u);
const record = z.record(z.string(), z.unknown());

/** Only fields used by the CLI are projected; Wrangler owns full validation. */
export interface BindingDefinition {
  readonly path: readonly string[];
  readonly shape: 'array' | 'object' | 'map' | 'names';
  readonly nameKey: 'binding' | 'name';
  readonly inherited: boolean;
  readonly schema: z.ZodType<Record<string, unknown>>;
  readonly optionalName?: boolean;
}

const row = (fields: z.ZodRawShape = {}) =>
  z.looseObject({ remote: z.boolean().optional(), ...fields });
const array = (
  path: string,
  fields: z.ZodRawShape = {},
  nameKey: 'binding' | 'name' = 'binding',
): BindingDefinition => ({
  path: path.split('.'),
  shape: 'array',
  nameKey,
  inherited: false,
  schema: row(fields),
});
const object = (path: string, inherited = false, optionalName = false): BindingDefinition => ({
  path: [path],
  shape: 'object',
  nameKey: 'binding',
  inherited,
  optionalName,
  schema: row(),
});
const map = (path: string, inherited: boolean): BindingDefinition => ({
  path: [path],
  shape: 'map',
  nameKey: 'binding',
  inherited,
  schema: record,
});

/**
 * Audited against Wrangler 4.135.0 config-schema.json and its normalization.
 * Keep path, shape and inheritance here: add, sync and deploy checks share it.
 * The schema coverage test detects new binding shapes when Wrangler is upgraded.
 * assets/logfwdr inherit; legacy blobs are top-level-only; version_metadata does
 * NOT inherit despite the missing note in Wrangler's JSON schema.
 */
export const BINDING_DEFINITIONS: readonly BindingDefinition[] = [
  map('vars', false),
  array('kv_namespaces', { id: text.optional(), preview_id: text.optional() }),
  array('d1_databases', { database_id: text.optional(), database_name: text.optional() }),
  array('r2_buckets', { bucket_name: text.optional() }),
  array('services', { service: worker }),
  array('hyperdrive', { id: text }),
  array('vectorize', { index_name: text }),
  array('workflows', { name: text.optional(), class_name: text, script_name: worker.optional() }),
  array('analytics_engine_datasets', { dataset: text.optional() }),
  array('durable_objects.bindings', { class_name: text, script_name: worker.optional() }, 'name'),
  array('queues.producers', { queue: text.optional() }),
  array(
    'send_email',
    {
      destination_address: text.optional(),
      allowed_destination_addresses: z.array(text).optional(),
      allowed_sender_addresses: z.array(text).optional(),
    },
    'name',
  ),
  array('ai_search_namespaces', { namespace: text }),
  array('ai_search', { instance_name: text }),
  array('agent_memory', { namespace: text }),
  object('browser'),
  object('ai'),
  object('images'),
  object('media'),
  object('stream'),
  object('version_metadata'),
  object('assets', true, true),
  array('mtls_certificates', { certificate_id: text }),
  array('dispatch_namespaces', { namespace: text.optional() }),
  {
    ...array('pipelines'),
    schema: row({ stream: text.optional(), pipeline: text.optional() }).refine(
      (value) => value.stream !== undefined || value.pipeline !== undefined,
    ),
  },
  array('secrets_store_secrets', { store_id: text, secret_name: text }),
  array('artifacts', { namespace: text }),
  array('flagship', { app_id: text.optional() }),
  array(
    'ratelimits',
    {
      namespace_id: text,
      simple: z.looseObject({
        limit: z.number().positive(),
        period: z.union([z.literal(10), z.literal(60)]),
      }),
    },
    'name',
  ),
  array('worker_loaders'),
  {
    ...array('vpc_networks'),
    schema: row({ tunnel_id: text.optional(), network_id: text.optional() }).refine(
      (value) => (value.tunnel_id === undefined) !== (value.network_id === undefined),
    ),
  },
  array('vpc_services', { service_id: text }),
  array('unsafe_hello_world'),
  array('unsafe.bindings', { type: text }, 'name'),
  { ...array('logfwdr.bindings', { destination: text }, 'name'), inherited: true },
  map('wasm_modules', true),
  map('text_blobs', true),
  map('data_blobs', true),
  {
    path: ['secrets', 'required'],
    shape: 'names',
    nameKey: 'name',
    inherited: false,
    schema: record,
  },
];

export interface ConfigBinding {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  /** Kept only internally. Reports must project name/kind, never values or IDs. */
  readonly value: Readonly<Record<string, unknown>>;
}

function checked<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid Wrangler field: ${field}.`);
  return parsed.data;
}

export function bindingDeclaration(
  definition: BindingDefinition,
  binding: string,
  options: unknown,
): Record<string, unknown> {
  const fields = checked(record, options, 'binding options');
  if (Object.hasOwn(fields, definition.nameKey))
    throw new Error(`Pass the binding name as BINDING, not in --options.${definition.nameKey}.`);
  // Discovery only needs the binding and class; creating a new Workflow
  // declaration also requires the native resource name.
  if (definition.path[0] === 'workflows') checked(text, fields.name, 'workflows.name');
  return checked(
    definition.schema,
    { ...fields, [definition.nameKey]: checked(name, binding, 'binding name') },
    definition.path.join('.'),
  );
}

/** Read effective binding names without normalizing or discarding future configuration. */
export function bindingInventory(
  root: Record<string, unknown>,
  selected = root,
): readonly ConfigBinding[] {
  const bindings: ConfigBinding[] = [];
  const names = new Set<string>();
  const add = (
    binding: unknown,
    definition: BindingDefinition,
    path: string,
    value: Record<string, unknown>,
  ) => {
    const checkedName = checked(name, binding, path);
    if (names.has(checkedName)) throw new Error(`Duplicate Worker binding name: ${checkedName}.`);
    names.add(checkedName);
    bindings.push({
      name: checkedName,
      kind: definition.path[0] === 'vars' ? 'var' : definition.path[0]!,
      path,
      value,
    });
  };
  for (const definition of BINDING_DEFINITIONS) {
    const [key, ...rest] = definition.path;
    if (key === undefined) continue;
    // Legacy blob/module maps are top-level-only in Wrangler, even when an env
    // happens to contain an unrecognized same-named field.
    const legacy = ['wasm_modules', 'text_blobs', 'data_blobs'].includes(key);
    let value: unknown = legacy
      ? root[key]
      : Object.hasOwn(selected, key) || !definition.inherited
        ? selected[key]
        : root[key];
    let path = key;
    if (value === undefined) continue;
    for (const nested of rest) {
      value = checked(record, value, path)[nested];
      path += `.${nested}`;
    }
    if (value === undefined) {
      if (key === 'durable_objects' || key === 'logfwdr')
        throw new Error(`Invalid Wrangler field: ${path}.`);
      continue;
    }
    if (definition.shape === 'map') {
      const fields = checked(record, value, path);
      for (const [binding, field] of Object.entries(fields)) {
        if (legacy) checked(text, field, path);
        add(binding, definition, path, {});
      }
    } else if (definition.shape === 'names') {
      for (const binding of checked(z.array(name), value, path)) add(binding, definition, path, {});
    } else {
      const rows =
        definition.shape === 'array'
          ? checked(z.array(record), value, path)
          : [checked(record, value, path)];
      for (const entry of rows) {
        const checkedRow = checked(definition.schema, entry, path);
        if (definition.optionalName && checkedRow[definition.nameKey] === undefined) continue;
        add(
          checkedRow[definition.nameKey],
          definition,
          `${path}.${definition.nameKey}`,
          checkedRow,
        );
      }
    }
  }
  return bindings;
}

/** Select only the already-validated rows a deployment check needs. */
export function bindingRows(
  bindings: readonly ConfigBinding[],
  kind: string,
): readonly Readonly<Record<string, unknown>>[] {
  return bindings.filter((binding) => binding.kind === kind).map((binding) => binding.value);
}
