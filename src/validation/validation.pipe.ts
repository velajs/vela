import { BadRequestException } from '../errors/http-exception';
import type { ArgumentMetadata, PipeTransform } from '../pipeline/types';

export class ValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const metatype = metadata.metatype as
      | { schema?: { parse(d: unknown): unknown } }
      | undefined;
    if (!metatype?.schema?.parse) return value;

    try {
      return metatype.schema.parse(value);
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'issues' in error &&
        Array.isArray((error as Record<string, unknown>).issues)
      ) {
        throw new BadRequestException({
          statusCode: 400,
          message: 'Validation failed',
          errors: (error as Record<string, unknown>).issues,
        });
      }
      throw error;
    }
  }
}
