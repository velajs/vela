import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BINDING_DEFINITIONS, bindingInventory } from './bindings.js';
import { isRecord } from './files.js';

/** Synthetic native configurations: names and credentials are never account data. */
const nativeConfig = {
  send_email: [{ name: 'MAIL', allowed_destination_addresses: ['test@example.com'] }],
  ai: { binding: 'AI' },
  browser: { binding: 'BROWSER' },
  images: { binding: 'IMAGES' },
  media: { binding: 'MEDIA' },
  stream: { binding: 'STREAM' },
  ai_search: [{ binding: 'SEARCH', instance_name: 'example-search' }],
  ai_search_namespaces: [{ binding: 'SEARCH_NAMESPACE', namespace: 'example' }],
  agent_memory: [{ binding: 'MEMORY', namespace: 'example' }],
  vectorize: [{ binding: 'VECTORS', index_name: 'example-index' }],
  hyperdrive: [{ binding: 'POSTGRES', id: 'example-id' }],
  pipelines: [{ binding: 'EVENTS', stream: 'example-stream' }],
  analytics_engine_datasets: [{ binding: 'METRICS' }],
  vpc_services: [{ binding: 'PRIVATE_API', service_id: 'example-service' }],
  vpc_networks: [{ binding: 'NETWORK', network_id: 'example-network' }],
  worker_loaders: [{ binding: 'LOADER' }],
  dispatch_namespaces: [{ binding: 'DISPATCH', namespace: 'example' }],
  artifacts: [{ binding: 'ARTIFACTS', namespace: 'example' }],
  flagship: [{ binding: 'FLAGS', app_id: 'example-app' }],
  secrets_store_secrets: [
    { binding: 'API_KEY', store_id: 'example-store', secret_name: 'example-key' },
  ],
  mtls_certificates: [{ binding: 'MTLS', certificate_id: 'example-cert' }],
  ratelimits: [{ name: 'LIMITER', namespace_id: '1', simple: { limit: 10, period: 60 } }],
  version_metadata: { binding: 'VERSION' },
  unsafe: { bindings: [{ name: 'FUTURE', type: 'future-native', future: { arbitrary: true } }] },
};

describe('Wrangler binding inventory', () => {
  it('covers native singleton, binding-row and name-row shapes without values in reports', () => {
    const inventory = bindingInventory(nativeConfig);
    expect(inventory).toHaveLength(24);
    expect(inventory.map((entry) => entry.name)).toContain('API_KEY');
    expect(inventory.map((entry) => entry.name)).toContain('MAIL');
  });

  it.each(Object.entries(nativeConfig))('checks cross-kind collisions for %s', (_key, value) => {
    const row = Array.isArray(value) ? value[0] : 'bindings' in value ? value.bindings[0] : value;
    if (!isRecord(row)) throw new Error('fixture');
    const binding = row.binding ?? row.name;
    if (typeof binding !== 'string') throw new Error('fixture');
    expect(() =>
      bindingInventory({ ...nativeConfig, vars: { [binding]: 'never-print-this' } }),
    ).toThrow(`Duplicate Worker binding name: ${binding}`);
  });

  it('does not inherit resources; assets/logfwdr inherit, legacy maps are top-level-only', () => {
    const root = {
      ...nativeConfig,
      assets: { binding: 'ASSETS', directory: './public' },
      logfwdr: { bindings: [{ name: 'LOGS', destination: 'example' }] },
      wasm_modules: { WASM: './example.wasm' },
      text_blobs: { TEXT: './example.txt' },
      data_blobs: { DATA: './example.bin' },
      vars: { PRODUCTION_ONLY: 'never-print-this' },
      secrets: { required: ['SECRET'] },
    };
    expect(bindingInventory(root, {}).map((entry) => entry.name)).toEqual([
      'ASSETS',
      'LOGS',
      'WASM',
      'TEXT',
      'DATA',
    ]);
    expect(
      bindingInventory(root, {
        assets: { directory: './staging' },
        logfwdr: { bindings: [] },
        text_blobs: { IGNORED: './other.txt' },
      }).map((entry) => entry.name),
    ).toEqual(['WASM', 'TEXT', 'DATA']);
    expect(() => bindingInventory(root, { vars: { ASSETS: 'collision' } })).toThrow(
      'Duplicate Worker binding',
    );
  });

  it('keeps unknown future config and counts unsafe names without interpreting their values', () => {
    const root = { future_bindings: [{ unexpected: true }], ...nativeConfig };
    const before = structuredClone(root);
    bindingInventory(root);
    expect(root).toEqual(before);
  });

  it.each([
    { ai: [] },
    { send_email: [{ binding: 'MAIL' }] },
    { flagship: [{ binding: 3 }] },
    { secrets_store_secrets: [{ binding: 'KEY', store_id: 4, secret_name: 'never-print-this' }] },
    { pipelines: [{ binding: 'PIPE' }] },
    { hyperdrive: [{ binding: 'DB' }] },
    { vpc_networks: [{ binding: 'NET' }] },
    { vpc_networks: [{ binding: 'NET', tunnel_id: 'a', network_id: 'b' }] },
    { ai_search: [{ binding: 'SEARCH' }] },
    { worker_loaders: {} },
    { secrets: { required: [4] } },
    { ratelimits: [{ name: 'LIMIT' }] },
  ])('rejects malformed known fields without echoing config values', (root) => {
    expect(() => bindingInventory(root)).toThrow('Invalid Wrangler field');
    try {
      bindingInventory(root);
    } catch (error) {
      expect(String(error)).not.toContain('never-print-this');
    }
  });

  it('counts required secrets but not queue consumers, tails, build defines or containers as ENV names', () => {
    expect(
      bindingInventory({
        secrets: { required: ['KEY'] },
        queues: { consumers: [{ queue: 'KEY' }] },
        tail_consumers: [{ service: 'KEY' }],
        define: { KEY: 'value' },
        containers: [{ name: 'KEY' }],
      }).map((entry) => entry.name),
    ).toEqual(['KEY']);
  });

  it('audits every installed-schema binding/name field and its documented inheritance', () => {
    const require = createRequire(import.meta.url);
    const schema: unknown = JSON.parse(
      readFileSync(
        join(dirname(require.resolve('wrangler/package.json')), 'config-schema.json'),
        'utf8',
      ),
    );
    if (!isRecord(schema) || !isRecord(schema.definitions))
      throw new Error('Wrangler schema changed');
    const definitions = schema.definitions;
    const resolve = (value: unknown): Record<string, unknown> => {
      if (!isRecord(value)) return {};
      return typeof value.$ref === 'string'
        ? resolve(definitions[value.$ref.split('/').at(-1) ?? ''])
        : value;
    };
    const config = resolve(definitions.RawConfig);
    if (!isRecord(config.properties)) throw new Error('Wrangler schema changed');
    const paths = new Set<string>();
    const walk = (value: unknown, path: string[]) => {
      if (path.length > 2) return;
      const node = resolve(value);
      const props = isRecord(node.properties) ? node.properties : {};
      if (
        props.binding ||
        (props.name &&
          ['send_email', 'ratelimits', 'durable_objects', 'unsafe', 'logfwdr'].includes(
            path[0] ?? '',
          ))
      )
        paths.add(path.join('.'));
      if (node.items) walk(node.items, path);
      if (Array.isArray(node.anyOf)) for (const variant of node.anyOf) walk(variant, path);
      for (const [key, child] of Object.entries(props)) walk(child, [...path, key]);
    };
    for (const [key, value] of Object.entries(config.properties))
      if (!['env', 'previews'].includes(key)) walk(value, [key]);
    const inventoryPaths = BINDING_DEFINITIONS.filter((entry) =>
      ['object', 'array'].includes(entry.shape),
    ).map((entry) => entry.path.join('.'));
    expect([...paths].toSorted()).toEqual(inventoryPaths.toSorted());
    for (const entry of BINDING_DEFINITIONS) {
      const field = resolve(config.properties[entry.path[0] ?? '']);
      if (
        typeof field.description === 'string' &&
        field.description.includes('not automatically inherited')
      )
        expect(entry.inherited, entry.path.join('.')).toBe(false);
    }
  });
});
