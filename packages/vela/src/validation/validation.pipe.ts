import { Injectable, Optional } from '../container/decorators';
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

// Constructed with `new ValidationPipe(schema)` or registered as a class
// provider (`APP_PIPE` with `useClass`), where the schema is simply absent.
@Injectable()
export class ValidationPipe implements PipeTransform {
  /** @deprecated No cross-boundary validation state is retained. Let the handler
   * own generated-route validation with validationOwner: 'handler' metadata. */
  static consumeValidated(_value: unknown, _schema: ValidationSchema): boolean {
    return false;
  }

  /** Explicit schema metadata shared with OpenAPI and programmatic route builders. */
  constructor(@Optional() readonly parser?: ValidationSchema) {}

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
    try {
      const result = parseSchema(schema, value);
      return isPromiseLike(result) ? Promise.resolve(result).catch(validationFailure) : result;
    } catch (error) {
      return validationFailure(error);
    }
  }
}

function validationFailure(error: unknown): never {
  if (error instanceof SchemaValidationError) {
    throw new BadRequestException('Validation failed', {
      details: { issues: error.issues },
      cause: error,
    });
  }
  throw error;
}
