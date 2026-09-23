import { BadRequestException } from '../errors/http-exception';
import type { ArgumentMetadata, PipeTransform } from '../pipeline/types';
import {
  parseSchema,
  parseSchemaAsync,
  resolveValidationSchema,
  type ValidationSchema,
} from './parse-schema';
import { isPromiseLike } from './promise-like';
import { SchemaValidationError } from './standard-schema';

export type { ValidationSchema } from './parse-schema';

export class ValidationPipe implements PipeTransform {
  /** @deprecated No cross-boundary validation state is retained. Let the handler
   * own generated-route validation with validationOwner: 'handler' metadata. */
  static consumeValidated(_value: unknown, _schema: ValidationSchema): boolean {
    return false;
  }

  /** Explicit schema metadata shared with OpenAPI and programmatic route builders. */
  constructor(readonly parser?: ValidationSchema) {}

  async transformAsync(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    const schema = this.#schema(metadata);
    if (!schema) return value;
    try {
      return await parseSchemaAsync(schema, value);
    } catch (error) {
      return validationFailure(error);
    }
  }

  #schema(metadata: ArgumentMetadata) {
    // Programmatic routes can document a schema while their handler/engine owns
    // validation. Explicit parameter pipes still validate at their chosen boundary.
    const metatype = metadata.metatype;
    if (
      this.parser === undefined &&
      metatype !== null &&
      typeof metatype === 'object' &&
      'validationOwner' in metatype &&
      metatype.validationOwner === 'handler'
    )
      return undefined;
    return resolveValidationSchema(this.parser ?? metatype);
  }

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = this.#schema(metadata);
    if (schema === undefined) return value;
    return parseValidated(schema, value);
  }
}

/**
 * The framework's HTTP validation failure: a 400 `BadRequestException` whose
 * details are the normalized schema issues (message, path, and code). It
 * renders as `{ error: { code: 'bad_request', message, details } }`.
 */
export function validationFailed(issues: SchemaValidationError['issues']): BadRequestException {
  return new BadRequestException('Validation failed', { details: issues });
}

/**
 * Parse one input boundary and report schema issues as {@link validationFailed}.
 * Synchronous schemas keep a synchronous result; errors thrown by validator
 * code are not validation failures and propagate unchanged.
 */
export function parseValidated(schema: ValidationSchema, value: unknown): unknown {
  try {
    const result = parseSchema(schema, value);
    return isPromiseLike(result) ? Promise.resolve(result).catch(validationFailure) : result;
  } catch (error) {
    return validationFailure(error);
  }
}

function validationFailure(error: unknown): never {
  if (error instanceof SchemaValidationError) throw validationFailed(error.issues);
  throw error;
}
