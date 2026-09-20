import { BadRequestException } from '../errors/http-exception';
import type { ArgumentMetadata, PipeTransform } from '../pipeline/types';
import { isSchemaParser, type RuntimeParser } from './dto';

function readSchema(metatype: unknown): RuntimeParser | undefined {
  if (isSchemaParser(metatype)) return metatype;
  if (
    metatype !== null &&
    (typeof metatype === 'object' || typeof metatype === 'function') &&
    'schema' in metatype
  ) {
    if (isSchemaParser(metatype.schema)) return metatype.schema;
    throw new TypeError('Validation metadata contains a schema without a parse() function.');
  }
  return undefined;
}

export class ValidationPipe implements PipeTransform {
  /** Explicit schema metadata shared with OpenAPI and programmatic route builders. */
  constructor(readonly parser?: RuntimeParser) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = this.parser ?? readSchema(metadata.metatype);
    if (schema === undefined) return value;

    try {
      return schema.parse(value);
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)) {
        throw new BadRequestException({
          statusCode: 400,
          message: 'Validation failed',
          errors: error.issues,
        });
      }
      throw error;
    }
  }
}
