import type { JsonSchema } from './types';

// Zod v4 exposes `schema.toJSONSchema()` on every schema instance — an
// authoritative, zero-cost converter. We delegate to it when present and
// strip the `$schema` meta so the result embeds cleanly into OpenAPI
// components. For non-Zod schemas (anything that doesn't expose the
// method) we return an empty (permissive) schema.

function stripOpenApiIncompatible(schema: JsonSchema): JsonSchema {
  const out = { ...schema } as Record<string, unknown>;
  delete out.$schema;
  // Zod v4 emits `additionalProperties: false` by default; users rarely
  // want that constraint in their published OpenAPI doc, so leave it in
  // — it's a faithful reflection of the schema. No change here.

  if (Array.isArray(out.properties)) {
    // shouldn't happen, but guard
  } else if (out.properties && typeof out.properties === 'object') {
    const props = out.properties as Record<string, JsonSchema>;
    const cleaned: Record<string, JsonSchema> = {};
    for (const [key, val] of Object.entries(props)) {
      cleaned[key] = stripOpenApiIncompatible(val);
    }
    out.properties = cleaned;
  }
  if (out.items && typeof out.items === 'object') {
    out.items = stripOpenApiIncompatible(out.items as JsonSchema);
  }
  return out as JsonSchema;
}

export function zodToJsonSchema(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== 'object') return {};

  const maybe = (schema as { toJSONSchema?: unknown }).toJSONSchema;
  if (typeof maybe === 'function') {
    try {
      const result = (maybe as () => unknown).call(schema);
      if (result && typeof result === 'object') {
        return stripOpenApiIncompatible(result as JsonSchema);
      }
    } catch {
      // Zod may refuse to convert certain schemas; fall through.
    }
  }

  return {};
}

// Zod v4 and v3 both name constructors `ZodOptional` / `ZodDefault` /
// `ZodNullable`. Checking the constructor name is cheap and avoids
// depending on internal `_def` shape.
function ctorName(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  return (schema as { constructor?: { name?: string } }).constructor?.name;
}

export function isOptional(schema: unknown): boolean {
  const name = ctorName(schema);
  return name === 'ZodOptional' || name === 'ZodDefault';
}

export function isNullable(schema: unknown): boolean {
  return ctorName(schema) === 'ZodNullable';
}
