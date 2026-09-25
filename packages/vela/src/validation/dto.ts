import { parseSchemaAsync } from './parse-schema';
import {
  isStandardSchema,
  validateSchema,
  standardJsonSchema,
  type StandardSchemaV1,
} from './standard-schema';

export interface DtoOptions {
  /** Stable name used by schema documentation and diagnostics. */
  name?: string;
  jsonSchema?: unknown;
  schemaConverter?: (direction: 'input' | 'output') => unknown;
}

/** A named Standard Schema descriptor retaining its input and output types. */
export interface DtoDefinition<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly name: string;
  readonly schema: S;
  parse(value: unknown): StandardSchemaV1.InferOutput<S> | Promise<StandardSchemaV1.InferOutput<S>>;
  parseAsync(value: unknown): Promise<StandardSchemaV1.InferOutput<S>>;
  toJSONSchema(direction?: 'input' | 'output'): unknown;
}

export function defineDto<S extends StandardSchemaV1>(
  schema: S,
  options: DtoOptions = {},
): DtoDefinition<S> {
  if (!isStandardSchema(schema))
    throw new TypeError('defineDto requires a Standard Schema validator.');
  const name = options.name ?? 'Dto';
  return Object.freeze({
    name,
    schema,
    parse: (value: unknown) => validateSchema(schema, value),
    parseAsync: (value: unknown) => parseSchemaAsync(schema, value),
    toJSONSchema: (direction: 'input' | 'output' = 'output'): unknown => {
      if (options.jsonSchema !== undefined) return options.jsonSchema;
      if (options.schemaConverter) return options.schemaConverter(direction);
      const converted = standardJsonSchema(schema, direction);
      if (converted !== undefined) return converted;
      throw new TypeError(`DTO '${name}' does not provide Standard JSON Schema conversion.`);
    },
  });
}
