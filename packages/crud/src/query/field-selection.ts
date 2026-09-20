/**
 * Field selection: `?fields=a,b,c` sparse-response projection.
 *
 * Faithful port of hono-crud 0.13's field-selection surface
 * (endpoints/types.ts): `parseFieldSelection` resolves the requested fields
 * against an allow-list / block-list / always-include / default set and can
 * gate computed and relation fields; `applyFieldSelection(...)` projects a row
 * (or array of rows) down to the selected keys. Selection is a no-op passthrough
 * when inactive, so callers never special-case the "no `?fields=`" path.
 */

/** Configuration for field selection on an endpoint. */
export interface FieldSelectionConfig {
  /** Fields allowed to be selected. Empty ⇒ all schema fields are allowed. */
  allowedFields?: string[];
  /** Fields never returned even if requested (e.g. `password`). */
  blockedFields?: string[];
  /** Fields always included regardless of the request (e.g. the primary key). */
  alwaysIncludeFields?: string[];
  /** Fields returned when no `?fields=` is supplied. Empty ⇒ all allowed. */
  defaultFields?: string[];
  /** Whether computed fields may be selected. @default true */
  allowComputedFields?: boolean;
  /** Whether relation fields may be selected. @default true */
  allowRelationFields?: boolean;
}

/** Parsed field selection. */
export interface FieldSelection {
  /** Fields to include in the response. */
  fields: string[];
  /** Whether selection is active (a non-empty `?fields=` was provided). */
  isActive: boolean;
}

/**
 * Parse the `fields` query parameter into a {@link FieldSelection}.
 *
 * @param fieldsParam   Raw comma-separated `?fields=` value.
 * @param config        Allow/block/always/default + computed/relation gating.
 * @param schemaFields  Available schema (column) field names.
 * @param computedFields Available computed field names.
 * @param relationFields Available relation field names.
 */
export function parseFieldSelection(
  fieldsParam: string | undefined | null,
  config: FieldSelectionConfig = {},
  schemaFields: string[] = [],
  computedFields: string[] = [],
  relationFields: string[] = [],
): FieldSelection {
  const {
    allowedFields = [],
    blockedFields = [],
    alwaysIncludeFields = [],
    defaultFields = [],
    allowComputedFields = true,
    allowRelationFields = true,
  } = config;

  // No `?fields=` → default set (marked inactive) or all fields.
  if (!fieldsParam || typeof fieldsParam !== 'string' || fieldsParam.trim() === '') {
    if (defaultFields.length > 0) {
      return { fields: [...new Set([...alwaysIncludeFields, ...defaultFields])], isActive: false };
    }
    return { fields: [], isActive: false };
  }

  const requested = fieldsParam
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  const available = new Set<string>();
  const admit = (field: string): void => {
    if (allowedFields.length === 0 || allowedFields.includes(field)) {
      if (!blockedFields.includes(field)) {
        available.add(field);
      }
    }
  };

  for (const field of schemaFields) admit(field);
  if (allowComputedFields) {
    for (const field of computedFields) admit(field);
  }
  if (allowRelationFields) {
    for (const field of relationFields) admit(field);
  }

  const selected = requested.filter((f) => available.has(f));
  const fields = [...new Set([...alwaysIncludeFields, ...selected])];

  return { fields, isActive: true };
}

/** Project a single record down to the selected fields (passthrough if inactive). */
export function applyFieldSelection<T extends Record<string, unknown>>(
  record: T,
  selection: FieldSelection,
): Record<string, unknown> {
  if (!selection.isActive || selection.fields.length === 0) {
    return record;
  }
  const result: Record<string, unknown> = {};
  for (const field of selection.fields) {
    if (field in record) {
      result[field] = record[field];
    }
  }
  return result;
}

/** Project an array of records down to the selected fields (passthrough if inactive). */
export function applyFieldSelectionToArray<T extends Record<string, unknown>>(
  records: T[],
  selection: FieldSelection,
): Array<Record<string, unknown>> {
  if (!selection.isActive || selection.fields.length === 0) {
    return records;
  }
  return records.map((record) => applyFieldSelection(record, selection));
}
