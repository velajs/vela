import {
  isStandardSchema,
  SchemaValidationError,
  validateSchema,
  type StandardSchemaV1,
} from './standard-schema';

/** Standard Schema, optionally wrapped in a named DTO descriptor. */
export type ValidationSchema = StandardSchemaV1 | { readonly schema: StandardSchemaV1 };

export type SchemaInput<S extends ValidationSchema> = S extends {
  readonly schema: infer Inner extends StandardSchemaV1;
}
  ? StandardSchemaV1.InferInput<Inner>
  : S extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<S>
    : never;

export type SchemaOutput<S extends ValidationSchema> = S extends {
  readonly schema: infer Inner extends StandardSchemaV1;
}
  ? StandardSchemaV1.InferOutput<Inner>
  : S extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<S>
    : never;

/** Read a schema or the descriptor a parameter class carries. */
export function resolveValidationSchema(value: unknown): StandardSchemaV1 | undefined {
  const seen = new Set<unknown>();
  while (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    if (isStandardSchema(value)) return value;
    if (!('schema' in value)) break;
    if (seen.has(value)) throw new TypeError('Circular schema descriptor.');
    seen.add(value);
    value = value.schema;
  }
  if (seen.size > 0)
    throw new TypeError('Validation metadata requires a Standard Schema validator.');
  return undefined;
}

export function isValidationSchema(value: unknown): value is ValidationSchema {
  return (
    isStandardSchema(value) ||
    (value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      'schema' in value &&
      isStandardSchema(value.schema))
  );
}

/** The Standard Schema or DTO descriptor a parameter class carries. */
export function staticSchema(metatype: unknown): ValidationSchema | undefined {
  if (typeof metatype !== 'function') return undefined;
  if (isStandardSchema(metatype)) return metatype;
  const schema: unknown = Reflect.get(metatype, 'schema');
  if (schema === undefined) return undefined;
  if (!isValidationSchema(schema))
    throw new TypeError('Validation metadata requires a Standard Schema validator.');
  return schema;
}

/** Validate once; exceptions thrown by validator code remain internal errors. */
export function parseSchema<S extends ValidationSchema>(
  schema: S,
  value: unknown,
): SchemaOutput<S> | Promise<SchemaOutput<S>>;
export function parseSchema(schema: ValidationSchema, value: unknown): unknown {
  const resolved = resolveValidationSchema(schema);
  if (!resolved) throw new TypeError('Expected a Standard Schema validator.');
  return validateSchema(resolved, value);
}

/** Async boundaries avoid Zod's sync-probe/retry Standard adapter by using its
 * public safeParseAsync result. No Zod runtime dependency or internal fields. */
export function parseSchemaAsync<S extends ValidationSchema>(
  schema: S,
  value: unknown,
): Promise<SchemaOutput<S>>;
export async function parseSchemaAsync(schema: ValidationSchema, value: unknown): Promise<unknown> {
  const resolved = resolveValidationSchema(schema);
  if (
    resolved &&
    isStandardSchema(resolved) &&
    resolved['~standard'].vendor === 'zod' &&
    'safeParseAsync' in resolved &&
    typeof resolved.safeParseAsync === 'function'
  ) {
    const result: unknown = await resolved.safeParseAsync(value);
    if (!result || typeof result !== 'object' || !('success' in result))
      throw new TypeError('Invalid safeParseAsync result');
    if (result.success === true && 'data' in result) return result.data;
    if (
      result.success === false &&
      'error' in result &&
      result.error !== null &&
      typeof result.error === 'object' &&
      'issues' in result.error &&
      Array.isArray(result.error.issues)
    )
      throw new SchemaValidationError(result.error.issues);
    throw new TypeError('Invalid safeParseAsync result');
  }
  return await parseSchema(schema, value);
}
