import type { JsonSchema } from './types';
import { parseJsonSchema } from './json-schema';
import { standardJsonSchema } from '../validation/standard-schema';

// Zod v4 exposes `schema.toJSONSchema()` on every schema instance — an
// authoritative, zero-cost converter. We delegate to it when present and
// strip the `$schema` meta so the result embeds cleanly into OpenAPI
// components. For non-Zod schemas (anything that doesn't expose the
// method) we return an empty (permissive) schema.

function stripOpenApiIncompatible(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  delete out.$schema;
  // Zod v4 emits `additionalProperties: false` by default; users rarely
  // want that constraint in their published OpenAPI doc, so leave it in
  // — it's a faithful reflection of the schema. No change here.

  if (out.properties) {
    const cleaned: Record<string, JsonSchema> = {};
    for (const [key, val] of Object.entries(out.properties)) {
      cleaned[key] = stripOpenApiIncompatible(val);
    }
    out.properties = cleaned;
  }
  if (out.items && typeof out.items === 'object') {
    out.items = stripOpenApiIncompatible(out.items);
  }
  return out;
}

export function zodToJsonSchema(
  schema: unknown,
  direction: 'input' | 'output' = 'output',
): JsonSchema {
  if (!schema || typeof schema !== 'object') return {};

  let standard: unknown;
  try {
    standard = standardJsonSchema(schema, direction);
  } catch {
    return {};
  }
  if (standard !== undefined)
    return stripOpenApiIncompatible(parseJsonSchema(standard, 'Standard JSON Schema result'));

  if ('toJSONSchema' in schema && typeof schema.toJSONSchema === 'function') {
    let result: unknown;
    try {
      result = 'schema' in schema ? schema.toJSONSchema(direction) : schema.toJSONSchema();
    } catch {
      // A schema library may not support export (e.g. transforms). Preserve
      // the missing-schema diagnostic rather than inventing its type.
      return {};
    }
    return stripOpenApiIncompatible(parseJsonSchema(result, 'toJSONSchema() result'));
  }

  return {};
}

// Zod v4 and v3 both name constructors `ZodOptional` / `ZodDefault` /
// `ZodNullable`. Checking the constructor name is cheap and avoids
// depending on internal `_def` shape.
function ctorName(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const constructor: unknown = schema.constructor;
  return typeof constructor === 'function' ? constructor.name : undefined;
}

export function isOptional(schema: unknown): boolean {
  const name = ctorName(schema);
  return name === 'ZodOptional' || name === 'ZodDefault';
}

export function isNullable(schema: unknown): boolean {
  return ctorName(schema) === 'ZodNullable';
}
