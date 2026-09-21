import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { JsonSchema } from './types';
import { parseJsonSchema } from './json-schema';
import {
  parseSchemaAsync,
  type ValidationSchema,
  type SchemaInput,
  type SchemaOutput,
} from '../validation/parse-schema';
import { standardJsonSchema, type StandardSchemaV1 } from '../validation/standard-schema';

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

/** A transforming output schema accepts handler values before producing wire output. */
export type EndpointHandlerOutput<S extends ValidationSchema> = S extends {
  readonly schema: infer Inner extends ValidationSchema;
}
  ? EndpointHandlerOutput<Inner>
  : S extends StandardSchemaV1
    ? SchemaInput<S>
    : SchemaOutput<S>;

export interface EndpointDefinition<
  Input extends EndpointRequest,
  Output,
  HandlerOutput = Output,
  InputSchema extends ValidationSchema = EndpointSchema<Input>,
  OutputSchema extends ValidationSchema = EndpointSchema<Output>,
> {
  readonly status: ContentfulStatusCode;
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly format: 'json' | 'text';
  readonly hasJsonBody: boolean;
  readonly queryParameters: readonly { name: string; multiple: boolean }[];
  /** Bind once: handler types cannot widen the schema-selected input/output. */
  bind<This>(
    handler: (
      this: This,
      input: NoInfer<Input>,
    ) => NoInfer<HandlerOutput> | Promise<NoInfer<HandlerOutput>>,
  ): (this: This, input: unknown) => Promise<Output>;
}

export function defineEndpoint<
  Input extends ValidationSchema,
  Output extends ValidationSchema,
>(options: {
  input: Input & (SchemaOutput<Input> extends EndpointRequest ? unknown : never);
  output: Output;
  status?: ContentfulStatusCode;
  format?: SchemaOutput<Output> extends string ? 'json' | 'text' : 'json';
}): EndpointDefinition<
  Extract<SchemaOutput<Input>, EndpointRequest>,
  SchemaOutput<Output>,
  EndpointHandlerOutput<Output>,
  Input,
  Output
>;
/** Explicit 1.x generic arguments remain available for synchronous parser contracts. */
export function defineEndpoint<Input extends EndpointRequest, Output>(options: {
  input: EndpointSchema<Input>;
  output: EndpointSchema<Output>;
  status?: ContentfulStatusCode;
  format?: Output extends string ? 'json' | 'text' : 'json';
}): EndpointDefinition<Input, Output>;
export function defineEndpoint(options: {
  input: ValidationSchema;
  output: ValidationSchema;
  status?: ContentfulStatusCode;
  format?: 'json' | 'text';
}) {
  const { input, output } = options;
  const inputSchema = endpointJsonSchema(input, 'input');
  const outputSchema = endpointJsonSchema(output, 'output');
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
    bind<This>(handler: (this: This, input: unknown) => unknown) {
      return async function (this: This, raw: unknown): Promise<unknown> {
        const value = await parseSchemaAsync(input, raw);
        return parseSchemaAsync(output, await handler.call(this, value));
      };
    },
  });
}

/** Erased only at framework dispatch; both boundaries remain runtime parsers. */
export interface RuntimeEndpointDefinition {
  readonly status: ContentfulStatusCode;
  readonly input: ValidationSchema;
  readonly output: ValidationSchema;
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
export function Endpoint<Input extends ValidationSchema, Output extends ValidationSchema>(
  definition: RuntimeEndpointDefinition & { readonly input: Input; readonly output: Output },
) {
  return <
    Handler extends (
      input: NoInfer<SchemaOutput<Input>>,
    ) => NoInfer<EndpointHandlerOutput<Output>> | Promise<NoInfer<EndpointHandlerOutput<Output>>>,
  >(
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

/** Conversion is directional and independent from runtime parsing. */
function endpointJsonSchema(schema: ValidationSchema, direction: 'input' | 'output'): JsonSchema {
  let result = standardJsonSchema(schema, direction);
  if (
    result === undefined &&
    'toJSONSchema' in schema &&
    typeof schema.toJSONSchema === 'function'
  ) {
    result = 'schema' in schema ? schema.toJSONSchema(direction) : schema.toJSONSchema();
  }
  if (result === undefined)
    throw new TypeError(
      `Endpoint ${direction} schema needs JSON Schema conversion; wrap it with defineDto and an explicit converter.`,
    );
  return parseJsonSchema(result, `endpoint ${direction} schema`);
}
