import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { JsonSchema } from './types';
import { parseJsonSchema } from './json-schema';

/** A runtime parser and its serializable contract travel together. */
export interface EndpointSchema<Value> {
  parse(value: unknown): Value;
  toJSONSchema(): unknown;
}

/** Matches hc's HTTP input groups; values are parsed by the endpoint schema. */
export interface EndpointRequest {
  param?: unknown;
  query?: unknown;
  header?: unknown;
  json?: unknown;
}

export interface EndpointDefinition<Input extends EndpointRequest, Output> {
  readonly status: ContentfulStatusCode;
  readonly input: EndpointSchema<Input>;
  readonly output: EndpointSchema<Output>;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly format: 'json' | 'text';
  readonly hasJsonBody: boolean;
  readonly queryParameters: readonly { name: string; multiple: boolean }[];
  /** Bind once: handler types cannot widen the schema-selected input/output. */
  bind<This>(
    handler: (this: This, input: NoInfer<Input>) => NoInfer<Output> | Promise<NoInfer<Output>>,
  ): (this: This, input: unknown) => Promise<Output>;
}

export function defineEndpoint<Input extends EndpointRequest, Output>(options: {
  input: EndpointSchema<Input>;
  output: EndpointSchema<Output>;
  status?: ContentfulStatusCode;
  format?: Output extends string ? 'json' | 'text' : 'json';
}): EndpointDefinition<Input, Output> {
  const { input, output } = options;
  const inputSchema = parseJsonSchema(input.toJSONSchema(), 'endpoint input schema');
  const outputSchema = parseJsonSchema(output.toJSONSchema(), 'endpoint output schema');
  if (inputSchema.type !== 'object')
    throw new Error('Endpoint input must be an object with param/query/header/json groups.');
  const querySchema = inputSchema.properties?.query;
  if (querySchema && querySchema.type !== 'object')
    throw new Error('Endpoint query group must export an object schema.');
  const queryParameters = Object.entries(querySchema?.properties ?? {}).map(([name, schema]) => {
    if (schema.$ref || schema.anyOf || schema.oneOf || schema.allOf || Array.isArray(schema.type))
      throw new Error(`Endpoint query ${name} needs a concrete scalar or array wire schema.`);
    return Object.freeze({ name, multiple: schema.type === 'array' });
  });
  return Object.freeze({
    input,
    output,
    inputSchema,
    outputSchema,
    format: options.format ?? 'json',
    hasJsonBody: inputSchema.properties?.json !== undefined,
    queryParameters: Object.freeze(queryParameters),
    status: options.status ?? 200,
    bind<This>(
      handler: (this: This, input: NoInfer<Input>) => NoInfer<Output> | Promise<NoInfer<Output>>,
    ) {
      return async function (this: This, raw: unknown): Promise<Output> {
        const value = input.parse(raw);
        return output.parse(await handler.call(this, value));
      };
    },
  });
}

/** Erased only at framework dispatch; both boundaries remain runtime parsers. */
export interface RuntimeEndpointDefinition {
  readonly status: ContentfulStatusCode;
  readonly input: EndpointSchema<unknown>;
  readonly output: EndpointSchema<unknown>;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly format: 'json' | 'text';
  readonly hasJsonBody: boolean;
  readonly queryParameters: readonly { name: string; multiple: boolean }[];
}

const definitions = new WeakMap<object, Map<string | symbol, RuntimeEndpointDefinition>>();

/**
 * Correlate a controller method with one schema-bearing endpoint definition.
 * The dispatcher must parse the HTTP input and handler result using this same
 * definition. This decorator records metadata; it does not wrap another route.
 */
export function Endpoint<Input extends EndpointRequest, Output>(
  definition: EndpointDefinition<Input, Output>,
) {
  return <Handler extends (input: NoInfer<Input>) => NoInfer<Output> | Promise<NoInfer<Output>>>(
    target: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<Handler>,
  ): void => {
    if (!descriptor.value) throw new Error('@Endpoint requires a method.');
    let methods = definitions.get(target);
    if (!methods) {
      methods = new Map();
      definitions.set(target, methods);
    }
    methods.set(key, definition);
  };
}

/** Shared by OpenAPI and route execution; no assertion of reflected metadata. */
export function getEndpointDefinition(
  controller: object,
  key: string | symbol,
): RuntimeEndpointDefinition | undefined {
  let current: unknown = typeof controller === 'function' ? controller.prototype : controller;
  while (current !== null && typeof current === 'object') {
    const definition = definitions.get(current)?.get(key);
    if (definition) return definition;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
