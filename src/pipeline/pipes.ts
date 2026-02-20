import { BadRequestException } from '../errors/http-exception';
import type { ArgumentMetadata, PipeTransform } from './types';

export class ParseIntPipe implements PipeTransform<string, number> {
  transform(value: string, metadata: ArgumentMetadata): number {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new BadRequestException(
        `Validation failed (numeric string expected)${metadata.data ? ` for parameter '${metadata.data}'` : ''}`,
      );
    }
    return parsed;
  }
}

export class ParseFloatPipe implements PipeTransform<string, number> {
  transform(value: string, metadata: ArgumentMetadata): number {
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
      throw new BadRequestException(
        `Validation failed (float string expected)${metadata.data ? ` for parameter '${metadata.data}'` : ''}`,
      );
    }
    return parsed;
  }
}

export class ParseBoolPipe implements PipeTransform<string, boolean> {
  transform(value: string, metadata: ArgumentMetadata): boolean {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException(
      `Validation failed (boolean string expected)${metadata.data ? ` for parameter '${metadata.data}'` : ''}`,
    );
  }
}

export class DefaultValuePipe<T = unknown> implements PipeTransform<T | undefined, T> {
  constructor(private readonly defaultValue: T) {}

  transform(value: T | undefined, _metadata: ArgumentMetadata): T {
    return value !== undefined && value !== null ? value : this.defaultValue;
  }
}

export class RequiredPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (value === undefined || value === null || value === '') {
      throw new BadRequestException(
        `Validation failed (value required)${metadata.data ? ` for parameter '${metadata.data}'` : ''}`,
      );
    }
    return value;
  }
}

export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: { parse(data: unknown): unknown }) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return this.schema.parse(value);
  }
}
