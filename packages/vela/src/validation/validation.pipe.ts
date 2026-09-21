import { BadRequestException } from '../errors/http-exception';
import type { ArgumentMetadata, PipeTransform } from '../pipeline/types';
import { isSchemaParser, type RuntimeParser } from './dto';
import {
  isStandardSchema,
  validateSchema,
  SchemaValidationError,
  type StandardSchemaV1,
} from './standard-schema';

export type ValidationSchema = RuntimeParser | StandardSchemaV1;
const receipts = new WeakMap<object, { schema: ValidationSchema; snapshot: unknown }>();
function unchanged(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth > 32) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)
  )
    return false;
  if (
    !Array.isArray(a) &&
    Object.getPrototypeOf(a) !== Object.prototype &&
    Object.getPrototypeOf(a) !== null
  )
    return false;
  const ak = Reflect.ownKeys(a),
    bk = Reflect.ownKeys(b);
  return (
    ak.length === bk.length &&
    ak.every((key) => {
      const left = Object.getOwnPropertyDescriptor(a, key),
        right = Object.getOwnPropertyDescriptor(b, key);
      return (
        left &&
        right &&
        'value' in left &&
        'value' in right &&
        unchanged(left.value, right.value, depth + 1)
      );
    })
  );
}
function remember(schema: ValidationSchema, value: unknown): unknown {
  if (value && typeof value === 'object') {
    try {
      receipts.set(value, { schema, snapshot: structuredClone(value) });
    } catch {
      /* Non-cloneable outputs are validated normally at the next boundary. */
    }
  }
  return value;
}

function readSchema(metatype: unknown): ValidationSchema | undefined {
  // DTO descriptors retain their original schema, including async Zod refinements.
  if (
    metatype !== null &&
    (typeof metatype === 'object' || typeof metatype === 'function') &&
    'schema' in metatype
  ) {
    if (isStandardSchema(metatype.schema) || isSchemaParser(metatype.schema))
      return metatype.schema;
    throw new TypeError(
      'Validation metadata contains a schema without a parse() function or Standard Schema validator.',
    );
  }
  if (isStandardSchema(metatype) || isSchemaParser(metatype)) return metatype;
  return undefined;
}

export class ValidationPipe implements PipeTransform {
  /** Consume an unchanged object result at a downstream boundary using the same schema.
   * Prevents double transforms in generated routes. Mutated or foreign values revalidate. */
  static consumeValidated(value: unknown, schema: ValidationSchema): boolean {
    if (!value || typeof value !== 'object') return false;
    const receipt = receipts.get(value);
    receipts.delete(value);
    return receipt?.schema === schema && unchanged(value, receipt.snapshot);
  }
  /** Explicit schema metadata shared with OpenAPI and programmatic route builders. */
  constructor(readonly parser?: ValidationSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = readSchema(this.parser ?? metadata.metatype);
    if (schema === undefined) return value;

    const standard = isStandardSchema(schema);
    const failure = (error: unknown): never => validationFailure(error, standard);
    try {
      const result = standard ? validateSchema(schema, value) : schema.parse(value);
      return result instanceof Promise
        ? result.then((value) => remember(schema, value)).catch(failure)
        : remember(schema, result);
    } catch (error: unknown) {
      return failure(error);
    }
  }
}

function validationFailure(error: unknown, standard: boolean): never {
  if (
    (!standard || error instanceof SchemaValidationError) &&
    error &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray(error.issues)
  ) {
    throw new BadRequestException({
      statusCode: 400,
      message: 'Validation failed',
      errors:
        error instanceof SchemaValidationError
          ? error.issues.map((issue: StandardSchemaV1.Issue) => ({
              ...issue,
              ...(issue.path
                ? {
                    path: issue.path.map((part) => {
                      const key = typeof part === 'object' ? part.key : part;
                      return typeof key === 'symbol' ? String(key) : key;
                    }),
                  }
                : {}),
            }))
          : error.issues,
    });
  }
  throw error;
}
