import type { SchemaParser } from '../validation/dto';
import {
  parseSchemaAsync,
  type SchemaInput,
  type SchemaOutput,
  type ValidationSchema,
} from '../validation';

/** An explicit domain projection with validation on both sides. */
export interface SerializerDefinition<Input, Wire, Output extends ValidationSchema> {
  /** Complete parser consumed by @Serialize; validates the domain before projection. */
  readonly schema: SchemaParser<Promise<Wire>>;
  /** Wire schema for explicit response documentation or other transport boundaries. */
  readonly output: Output;
  parse(value: unknown): Promise<Wire>;
  serialize(value: Input): Promise<Wire>;
}

/**
 * Compose schemas and a projection without constructing or reflecting on domain objects.
 * The input schema must validate unknown values before the projection receives a domain type.
 * Each call parses the input, awaits the projection, then parses the wire output once.
 */
export function defineSerializer<
  Input extends ValidationSchema,
  Output extends ValidationSchema,
>(options: {
  input: Input;
  output: Output;
  project: (
    value: NoInfer<SchemaOutput<Input>>,
  ) => NoInfer<SchemaInput<Output>> | PromiseLike<NoInfer<SchemaInput<Output>>>;
}): SerializerDefinition<SchemaInput<Input>, SchemaOutput<Output>, Output> {
  const { input, output, project } = options;
  const parse = async (value: unknown): Promise<SchemaOutput<Output>> => {
    const domain = await parseSchemaAsync(input, value);
    return parseSchemaAsync(output, await project(domain));
  };
  return Object.freeze({
    schema: Object.freeze({ parse }),
    output,
    parse,
    serialize: parse,
  });
}
