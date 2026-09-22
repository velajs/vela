import { z } from 'zod';

// This is the projection consumed by code generation, not a claim that an
// arbitrary document satisfies every OpenAPI requirement. Decode both JSON
// input and runtime-generated metadata before accessing their nested fields.
const schemaType = z.enum(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
type SchemaType = z.infer<typeof schemaType>;
type Scalar = string | number | boolean | null;

export type ContractSchema = boolean | ContractSchemaObject;
export interface ContractSchemaObject {
  type?: SchemaType | SchemaType[];
  format?: string;
  enum?: Scalar[];
  const?: unknown;
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  items?: ContractSchema;
  properties?: Record<string, ContractSchema>;
  required?: string[];
  additionalProperties?: ContractSchema;
  oneOf?: ContractSchema[];
  anyOf?: ContractSchema[];
  allOf?: ContractSchema[];
  $ref?: string;
  [keyword: string]: unknown;
}

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const schema: z.ZodType<ContractSchema> = z.lazy(() =>
  z.union([
    z.boolean(),
    z
      .object({
        type: z.union([schemaType, z.array(schemaType).nonempty()]).optional(),
        format: z.string().optional(),
        enum: z.array(scalar).optional(),
        const: scalar.optional(),
        nullable: z.boolean().optional(),
        readOnly: z.boolean().optional(),
        writeOnly: z.boolean().optional(),
        items: schema.optional(),
        properties: z.record(z.string(), schema).optional(),
        required: z.array(z.string()).optional(),
        additionalProperties: schema.optional(),
        oneOf: z.array(schema).optional(),
        anyOf: z.array(schema).optional(),
        allOf: z.array(schema).optional(),
        $ref: z.string().min(1).optional(),
      })
      .passthrough(),
  ]),
);

const parameter = z
  .object({
    name: z.string().min(1),
    in: z.enum(['path', 'query', 'header', 'cookie']),
    required: z.boolean().optional(),
    schema: schema.optional(),
    style: z.string().optional(),
    explode: z.boolean().optional(),
    // Keep unsupported representations explicit so they cannot disappear
    // during projection and accidentally become a fabricated string input.
    $ref: z.string().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();
export type ContractParameter = z.infer<typeof parameter>;

const media = z
  .object({ schema: schema.optional(), encoding: z.unknown().optional() })
  .passthrough();
const content = z.record(z.string(), media);
const requestBody = z
  .object({
    required: z.boolean().optional(),
    content: content.optional(),
    $ref: z.string().optional(),
  })
  .passthrough();
const response = z
  .object({
    'x-vela-response-format': z.enum(['binary', 'stream', 'response']).optional(),
    content: content.optional(),
    $ref: z.string().optional(),
  })
  .passthrough();
const operation = z
  .object({
    parameters: z.array(parameter).optional(),
    requestBody: requestBody.optional(),
    responses: z.record(z.string(), response),
    'x-vela-client-unsupported': z.array(z.string()).optional(),
  })
  .passthrough();
export type ContractOperation = z.infer<typeof operation>;

const pathItem = z
  .object({
    get: operation.optional(),
    post: operation.optional(),
    put: operation.optional(),
    patch: operation.optional(),
    delete: operation.optional(),
    options: operation.optional(),
    head: operation.optional(),
    parameters: z.unknown().optional(),
    $ref: z.string().optional(),
  })
  .passthrough();

const document = z.object({
  openapi: z.string().regex(/^3\.[01]\.\d+$/, 'expected OpenAPI 3.0.x or 3.1.x'),
  paths: z.record(z.string(), pathItem),
  components: z
    .object({ schemas: z.record(z.string(), schema).optional() })
    .passthrough()
    .optional(),
});

/** Read only structurally validated data. Unsupported constructs remain explicit. */
export function parseClientContractDocument(input: unknown): z.infer<typeof document> {
  // Zod recursively walks schemas. Refuse cyclic/excessively deep object input
  // (JSON files cannot contain cycles) with a diagnostic rather than overflowing.
  checkTree(input, '$', new Set<object>(), 0);
  const result = document.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '$'}: ${issue.message}`,
    );
    throw new Error(`Invalid OpenAPI client contract:\n${details.join('\n')}`);
  }
  return result.data;
}

function checkTree(value: unknown, at: string, ancestors: Set<object>, depth: number): void {
  if (value === null || typeof value !== 'object') return;
  if (depth > 100)
    throw new Error(`Invalid OpenAPI client contract: ${at} exceeds 100 nested levels.`);
  if (ancestors.has(value))
    throw new Error(`Invalid OpenAPI client contract: ${at} contains a cycle; use $ref.`);
  ancestors.add(value);
  for (const [key, child] of Object.entries(value))
    checkTree(child, `${at}.${key}`, ancestors, depth + 1);
  ancestors.delete(value);
}
