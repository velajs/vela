import {
  parseSchemaAsync,
  type SchemaInput,
  type SchemaOutput,
  type ValidationSchema,
} from '../validation/parse-schema';
import {
  SchemaValidationError,
  standardJsonSchema,
  type StandardJSONSchemaV1,
  type StandardSchemaV1,
} from '../validation/standard-schema';

/**
 * An explicit domain projection with validation on both sides. It is a
 * Standard Schema from the domain input to the wire output, so it serves as a
 * route's `response` (the handler returns the domain value; the route sends
 * the projection) and documents the wire schema in OpenAPI.
 */
export interface SerializerDefinition<
  Input,
  Wire,
  Output extends ValidationSchema,
> extends StandardSchemaV1<Input, Wire> {
  readonly '~standard': StandardSchemaV1.Props<Input, Wire> &
    StandardJSONSchemaV1.Props<Input, Wire>;
  /** Wire schema for explicit response documentation or other transport boundaries. */
  readonly output: Output;
  parse(value: unknown): Promise<Wire>;
  serialize(value: Input): Promise<Wire>;
}

function describe(
  schema: ValidationSchema,
  direction: 'input' | 'output',
  target: string,
): Record<string, unknown> {
  const converted =
    standardJsonSchema(schema, direction, target) ??
    ('toJSONSchema' in schema && typeof schema.toJSONSchema === 'function'
      ? schema.toJSONSchema(direction)
      : undefined);
  if (converted === null || typeof converted !== 'object')
    throw new TypeError(`The serializer's ${direction} schema has no JSON Schema conversion`);
  return { ...converted };
}

/**
 * Compose schemas and a projection without constructing or reflecting on domain objects.
 * The input schema must validate unknown values before the projection receives a domain type.
 * Each call parses the input, awaits the projection, then parses the wire output once.
 *
 * @example
 * ```ts
 * const publicAccount = defineSerializer({
 *   input: Account,
 *   output: z.object({ id: z.string(), displayName: z.string() }),
 *   project: (account) => ({ id: account.id, displayName: account.name }),
 * });
 *
 * @Get('/:id', { response: publicAccount })
 * find(@Param('id') id: string) { return this.accounts.find(id); }
 * ```
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
    '~standard': Object.freeze({
      version: 1 as const,
      vendor: 'vela',
      async validate(value: unknown) {
        try {
          return { value: await parse(value) };
        } catch (error) {
          if (error instanceof SchemaValidationError) return { issues: error.issues };
          throw error;
        }
      },
      jsonSchema: Object.freeze({
        input: ({ target }: StandardJSONSchemaV1.Options) => describe(input, 'input', target),
        output: ({ target }: StandardJSONSchemaV1.Options) => describe(output, 'output', target),
      }),
    }),
    output,
    parse,
    serialize: parse,
  });
}
