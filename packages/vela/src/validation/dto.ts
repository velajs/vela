import { validateSchema, standardJsonSchema, type StandardSchemaV1 } from './standard-schema';

/** A parser's output is inferred from the supplied schema. */
export interface SchemaParser<Value> {
  parse(value: unknown): Value;
}

/** A parser at a dynamic framework boundary; its output must remain unknown. */
export type RuntimeParser = SchemaParser<unknown>;

/** Structural support for Zod and other schema libraries; core imports none. */
export interface DtoSchema<Value> extends SchemaParser<Value> {
  toJSONSchema?(): unknown;
}

export interface DtoOptions {
  /** Stable name used by schema documentation and diagnostics. */
  name?: string;
  jsonSchema?: unknown;
  schemaConverter?: (direction: 'input' | 'output') => unknown;
}

/** A named schema descriptor. Parsed values are data, never pretend class instances. */
export interface DtoDefinition<Value> extends SchemaParser<Value> {
  readonly name: string;
  readonly schema: DtoSchema<Value>;
  toJSONSchema(): unknown;
}

export interface StandardDtoDefinition<Input, Output> {
  readonly name: string;
  readonly schema: StandardSchemaV1<Input, Output>;
  parse(value: unknown): Output | Promise<Output>;
  toJSONSchema(direction?: 'input' | 'output'): unknown;
}

export function defineDto<Value>(
  schema: DtoSchema<Value>,
  options?: DtoOptions,
): DtoDefinition<Value>;
export function defineDto<Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  options?: DtoOptions,
): StandardDtoDefinition<Input, Output>;
export function defineDto<Value>(
  schema: DtoSchema<Value> | StandardSchemaV1<unknown, Value>,
  options: DtoOptions = {},
): DtoDefinition<Value> | StandardDtoDefinition<unknown, Value> {
  const name = options.name ?? 'Dto';
  const toJSONSchema = (direction: 'input' | 'output' = 'output'): unknown => {
    if (options.jsonSchema !== undefined) return options.jsonSchema;
    if (options.schemaConverter) return options.schemaConverter(direction);
    const converted = standardJsonSchema(schema, direction);
    if (converted !== undefined) return converted;
    if ('toJSONSchema' in schema && schema.toJSONSchema) return schema.toJSONSchema();
    throw new TypeError(
      `DTO '${name}' does not provide toJSONSchema() or Standard JSON Schema conversion.`,
    );
  };
  if (isSchemaParser(schema)) {
    return Object.freeze({
      name,
      schema,
      parse: (value: unknown) => schema.parse(value),
      toJSONSchema,
    });
  }
  return Object.freeze({
    name,
    schema,
    parse: (value: unknown) => validateSchema(schema, value),
    toJSONSchema,
  });
}

export function isSchemaParser(value: unknown): value is SchemaParser<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'parse' in value &&
    typeof value.parse === 'function'
  );
}
