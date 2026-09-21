import { z } from 'zod';
import type { CrudFieldMetadata } from '../schema/contracts';

/** Normalize the Zod authoring path once, without exporting Zod internals to adapters. */
export function fieldMetadata(schema: unknown): Readonly<CrudFieldMetadata> {
  let optional = false,
    nullable = false;
  for (let depth = 0; depth < 32; depth++) {
    if (
      schema instanceof z.ZodOptional ||
      schema instanceof z.ZodDefault ||
      schema instanceof z.ZodPrefault
    ) {
      optional = true;
      schema = schema.unwrap();
    } else if (schema instanceof z.ZodNullable) {
      nullable = true;
      schema = schema.unwrap();
    } else if (
      schema instanceof z.ZodReadonly ||
      schema instanceof z.ZodNonOptional ||
      schema instanceof z.ZodCatch
    ) {
      schema = schema.unwrap();
    } else break;
  }
  const type =
    schema instanceof z.ZodString
      ? 'string'
      : schema instanceof z.ZodNumber
        ? 'number'
        : schema instanceof z.ZodBoolean
          ? 'boolean'
          : schema instanceof z.ZodDate
            ? 'date'
            : 'unknown';
  return Object.freeze({ type, optional, nullable });
}
