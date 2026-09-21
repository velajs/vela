import type { RuntimeParser, SchemaParser } from './dto';
import { isPromiseLike } from './promise-like';
import {
  isStandardSchema,
  SchemaValidationError,
  validateSchema,
  type StandardSchemaV1,
} from './standard-schema';

/** Portable structural boundary; descriptors retain their concrete underlying schema. */
export type ValidationSchema =
  | RuntimeParser
  | StandardSchemaV1
  | {
      readonly schema: RuntimeParser | StandardSchemaV1;
    };

export type SchemaInput<S extends ValidationSchema> = S extends {
  readonly schema: infer Inner extends ValidationSchema;
}
  ? SchemaInput<Inner>
  : S extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<S>
    : unknown;

export type SchemaOutput<S extends ValidationSchema> = S extends {
  readonly schema: infer Inner extends ValidationSchema;
}
  ? SchemaOutput<Inner>
  : S extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<S>
    : S extends { parseAsync(value: unknown): infer Output }
      ? Awaited<Output>
      : S extends SchemaParser<infer Output>
        ? Awaited<Output>
        : never;

export function resolveValidationSchema(
  value: unknown,
): RuntimeParser | StandardSchemaV1 | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined;
  if ('schema' in value) {
    const schema = value.schema;
    if (isStandardSchema(schema) || isParser(schema)) return schema;
    throw new TypeError(
      'Validation metadata contains a schema without a parse() function or Standard Schema validator.',
    );
  }
  return isStandardSchema(value) || isParser(value) ? value : undefined;
}

/** Recognize supported schema metadata without accepting malformed descriptors. */
export function isValidationSchema(value: unknown): value is ValidationSchema {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'schema' in value
  )
    return isStandardSchema(value.schema) || isParser(value.schema);
  return isStandardSchema(value) || isParser(value);
}

function isParser(value: unknown): value is RuntimeParser {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'parse' in value &&
    typeof value.parse === 'function'
  );
}

function legacyFailure(error: unknown): never {
  if (error instanceof SchemaValidationError) throw error;
  if (
    error !== null &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray(error.issues)
  ) {
    throw new SchemaValidationError(error.issues);
  }
  throw error;
}

/** Parse one boundary once. Only structured legacy failures become validation errors;
 * exceptions thrown by Standard validators remain untouched. */
export function parseSchema<S extends ValidationSchema>(
  schema: S,
  value: unknown,
): SchemaOutput<S> | Promise<SchemaOutput<S>>;
export function parseSchema(schema: ValidationSchema, value: unknown): unknown {
  const resolved = resolveValidationSchema(schema);
  if (!resolved)
    throw new TypeError('Expected a schema with parse() or a Standard Schema validator.');
  if (isStandardSchema(resolved)) return validateSchema(resolved, value);
  try {
    const result = resolved.parseAsync ? resolved.parseAsync(value) : resolved.parse(value);
    return isPromiseLike(result) ? Promise.resolve(result).catch(legacyFailure) : result;
  } catch (error) {
    return legacyFailure(error);
  }
}

export async function parseSchemaAsync<S extends ValidationSchema>(
  schema: S,
  value: unknown,
): Promise<SchemaOutput<S>> {
  return await parseSchema(schema, value);
}
