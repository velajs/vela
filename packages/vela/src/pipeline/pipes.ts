import { BadRequestException } from '../errors/http-exception';
import { parseValidated } from '../validation/validation.pipe';
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

/**
 * Validates with one Zod (or other `parse`-based) schema. Schema issues become
 * the same 400 validation failure as `ValidationPipe`, with the issue list in
 * `error.details`; errors thrown by schema code propagate unchanged.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: { parse(data: unknown): unknown }) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return parseValidated(this.schema, value);
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_VERSION_REGEX: Record<string, RegExp> = {
  '3': /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  '4': /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  '5': /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
};

export interface ParseUUIDPipeOptions {
  version?: '3' | '4' | '5';
}

export class ParseUUIDPipe implements PipeTransform<string, string> {
  constructor(private readonly options?: ParseUUIDPipeOptions) {}

  transform(value: string, metadata: ArgumentMetadata): string {
    const regex = this.options?.version ? UUID_VERSION_REGEX[this.options.version] : UUID_REGEX;
    if (!regex!.test(value)) {
      throw new BadRequestException(
        `Validation failed (uuid${this.options?.version ? ` v${this.options.version}` : ''} expected)${metadata.data ? ` for parameter '${metadata.data}'` : ''}`,
      );
    }
    return value;
  }
}

export class ParseEnumPipe<T extends Record<string, string | number>> implements PipeTransform<
  string,
  T[keyof T]
> {
  private readonly allowedValues: Set<string | number>;
  private readonly valuesLabel: string;

  constructor(enumType: T) {
    const values = Object.values(enumType);
    this.allowedValues = new Set(values);
    this.valuesLabel = values.join(', ');
  }

  transform(value: string, metadata: ArgumentMetadata): T[keyof T] {
    if (!this.allowedValues.has(value)) {
      throw new BadRequestException(
        `Validation failed (${this.valuesLabel} expected)${metadata.data ? ` for parameter '${metadata.data}'` : ''}`,
      );
    }
    return value as T[keyof T];
  }
}

export interface ParseArrayPipeOptions {
  separator?: string;
  optional?: boolean;
}

export class ParseArrayPipe implements PipeTransform {
  constructor(private readonly options?: ParseArrayPipeOptions) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown[] {
    if (value === undefined || value === null || value === '') {
      if (this.options?.optional) return [];
      throw new BadRequestException(
        `Validation failed (array expected)${metadata.data ? ` for parameter '${metadata.data}'` : ''}`,
      );
    }
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      const sep = this.options?.separator ?? ',';
      return value
        .split(sep)
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    }
    throw new BadRequestException(
      `Validation failed (array expected)${metadata.data ? ` for parameter '${metadata.data}'` : ''}`,
    );
  }
}
