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
}

/** A named schema descriptor. Parsed values are data, never pretend class instances. */
export interface DtoDefinition<Value> extends SchemaParser<Value> {
  readonly name: string;
  readonly schema: DtoSchema<Value>;
  toJSONSchema(): unknown;
}

export function defineDto<Value>(
  schema: DtoSchema<Value>,
  options: DtoOptions = {},
): DtoDefinition<Value> {
  const name = options.name ?? 'Dto';
  return Object.freeze({
    name,
    schema,
    parse(value: unknown): Value {
      return schema.parse(value);
    },
    toJSONSchema(): unknown {
      if (schema.toJSONSchema === undefined) {
        throw new TypeError(`DTO '${name}' does not provide toJSONSchema().`);
      }
      return schema.toJSONSchema();
    },
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
