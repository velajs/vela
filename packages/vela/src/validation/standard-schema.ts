import type { StandardSchemaV1 } from '@standard-schema/spec';
import { isPromiseLike } from './promise-like';

export type { StandardSchemaV1, StandardJSONSchemaV1 } from '@standard-schema/spec';

/** A validation failure, distinct from an exception thrown by validator code. */
export class SchemaValidationError extends Error {
  // Keep the 1.x public path union; runtime normalization selects safe wire fields.
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super('Validation failed');
    this.name = 'SchemaValidationError';
    this.issues = normalizeIssues(issues);
  }
}

/** Safe, transport-neutral issue fields. Paths preserve literal keys and array indices. */
export interface ValidationIssue {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly code?: string;
}

function normalizeIssues(issues: readonly unknown[]): readonly ValidationIssue[] {
  return Object.freeze(
    issues.map((issue) => {
      if (
        !issue ||
        typeof issue !== 'object' ||
        !('message' in issue) ||
        typeof issue.message !== 'string'
      )
        throw new TypeError('Invalid schema issue');
      let path: (string | number)[] | undefined;
      if ('path' in issue && issue.path !== undefined) {
        if (!Array.isArray(issue.path)) throw new TypeError('Invalid schema issue path');
        path = issue.path.map((part: unknown) => {
          const key = part !== null && typeof part === 'object' && 'key' in part ? part.key : part;
          if (typeof key === 'string' || typeof key === 'number') return key;
          if (typeof key === 'symbol') return String(key);
          throw new TypeError('Invalid schema issue path segment');
        });
      }
      return Object.freeze({
        message: issue.message,
        ...(path ? { path: Object.freeze(path) } : {}),
        ...('code' in issue && typeof issue.code === 'string' ? { code: issue.code } : {}),
      });
    }),
  );
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (!('~standard' in value)) return false;
  const props = value['~standard'];
  return (
    props !== null &&
    typeof props === 'object' &&
    'version' in props &&
    props.version === 1 &&
    'vendor' in props &&
    typeof props.vendor === 'string' &&
    'validate' in props &&
    typeof props.validate === 'function'
  );
}

function validated<Output>(result: StandardSchemaV1.Result<Output>): Output {
  if (result === null || typeof result !== 'object')
    throw new TypeError('Invalid Standard Schema result');
  if (result.issues !== undefined) {
    if (!Array.isArray(result.issues)) throw new TypeError('Invalid Standard Schema issues');
    throw new SchemaValidationError(result.issues);
  }
  if (!('value' in result)) throw new TypeError('Standard Schema result has no value');
  return result.value;
}

/** Preserves synchronous results; asynchronous validators are awaited by the pipeline. */
export function validateSchema<Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: unknown,
): Output | Promise<Output> {
  const result = schema['~standard'].validate(value);
  return isPromiseLike(result) ? Promise.resolve(result).then(validated) : validated(result);
}

/**
 * Conversion is independent of validation and never guesses a schema's shape.
 * `libraryOptions` pass through to the schema library's converter.
 */
export function standardJsonSchema(
  schema: unknown,
  direction: 'input' | 'output' = 'output',
  target = 'draft-2020-12',
  libraryOptions?: Record<string, unknown>,
): unknown {
  if (
    schema === null ||
    (typeof schema !== 'object' && typeof schema !== 'function') ||
    !('~standard' in schema)
  )
    return undefined;
  const props = schema['~standard'];
  if (!props || typeof props !== 'object' || !('jsonSchema' in props)) return undefined;
  const converter = props.jsonSchema;
  if (!converter || typeof converter !== 'object' || !(direction in converter)) return undefined;
  const convert =
    direction === 'input' && 'input' in converter
      ? converter.input
      : direction === 'output' && 'output' in converter
        ? converter.output
        : undefined;
  if (typeof convert !== 'function') return undefined;
  return convert.call(converter, libraryOptions ? { target, libraryOptions } : { target });
}
