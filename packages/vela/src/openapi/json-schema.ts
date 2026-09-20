import type { JsonSchema } from './types';

/** Validate every typed field before admitting raw/reflected data as JsonSchema. */
export function parseJsonSchema(value: unknown, at = 'schema'): JsonSchema {
  return parseSchema(value, at, new Set<object>(), 0);
}

function parseSchema(
  value: unknown,
  at: string,
  ancestors: Set<object>,
  depth: number,
): JsonSchema {
  if (!isRecord(value)) throw new Error(`${at}: expected a JSON Schema object.`);
  if (depth > 100 || ancestors.has(value))
    throw new Error(`${at}: recursive schema objects must use $ref.`);
  ancestors.add(value);
  try {
    const result: JsonSchema = {};
    const type = value.type;
    if (type !== undefined) {
      result.type = Array.isArray(type)
        ? readStrings(type, `${at}.type`)
        : readString(type, `${at}.type`);
      const types = typeof result.type === 'string' ? [result.type] : result.type;
      if (
        !types.length ||
        types.some(
          (entry) =>
            !['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'].includes(entry),
        )
      ) {
        throw new Error(`${at}.type: unsupported JSON Schema type.`);
      }
    }
    for (const key of ['format', 'description', 'pattern', '$ref'] as const) {
      if (value[key] !== undefined) result[key] = readString(value[key], `${at}.${key}`);
    }
    for (const key of ['nullable', 'readOnly', 'writeOnly'] as const) {
      const member = value[key];
      if (member !== undefined) {
        if (typeof member !== 'boolean') throw new Error(`${at}.${key}: expected a boolean.`);
        result[key] = member;
      }
    }
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength'] as const) {
      const member = value[key];
      if (member !== undefined) {
        if (typeof member !== 'number' || !Number.isFinite(member))
          throw new Error(`${at}.${key}: expected a finite number.`);
        result[key] = member;
      }
    }
    if (value.required !== undefined)
      result.required = readStrings(value.required, `${at}.required`);
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum)) throw new Error(`${at}.enum: expected an array.`);
      result.enum = value.enum.map((entry: unknown) => {
        if (
          entry === null ||
          typeof entry === 'string' ||
          typeof entry === 'boolean' ||
          (typeof entry === 'number' && Number.isFinite(entry))
        )
          return entry;
        throw new Error(`${at}.enum: expected finite JSON scalar values.`);
      });
    }
    if (value.items !== undefined)
      result.items = parseSchema(value.items, `${at}.items`, ancestors, depth + 1);
    if (value.properties !== undefined) {
      if (!isRecord(value.properties)) throw new Error(`${at}.properties: expected an object.`);
      result.properties = Object.fromEntries(
        Object.entries(value.properties).map(([key, member]) => [
          key,
          parseSchema(member, `${at}.properties.${key}`, ancestors, depth + 1),
        ]),
      );
    }
    if (value.additionalProperties !== undefined) {
      result.additionalProperties =
        typeof value.additionalProperties === 'boolean'
          ? value.additionalProperties
          : parseSchema(
              value.additionalProperties,
              `${at}.additionalProperties`,
              ancestors,
              depth + 1,
            );
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const member = value[key];
      if (member !== undefined) {
        if (!Array.isArray(member)) throw new Error(`${at}.${key}: expected an array.`);
        result[key] = member.map((entry: unknown, index) =>
          parseSchema(entry, `${at}.${key}[${index}]`, ancestors, depth + 1),
        );
      }
    }
    // Unknown extensions are intentionally unknown in JsonSchema. Known
    // typed members above are never copied from unchecked reflection data.
    for (const [key, member] of Object.entries(value)) {
      if (!KNOWN_FIELDS.has(key))
        Object.defineProperty(result, key, {
          value: member,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

const KNOWN_FIELDS = new Set([
  'type',
  'format',
  'description',
  'pattern',
  '$ref',
  'nullable',
  'readOnly',
  'writeOnly',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'required',
  'enum',
  'items',
  'properties',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at}: expected a string.`);
  return value;
}

function readStrings(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected an array of strings.`);
  return value.map((entry: unknown) => readString(entry, at));
}
