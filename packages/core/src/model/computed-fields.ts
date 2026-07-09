/**
 * Apply a model's computed-field functions to fetched records.
 *
 * Computed fields are runtime-only (never stored). Each is computed from the
 * stored record and merged onto the response object; a compute that throws
 * yields `undefined` for that field (parity with hono-crud 0.13
 * `core/computed-fields.ts` — computation errors are swallowed per field).
 *
 * Parity note: the appliers take the NORMALIZED {@link Model} (reading
 * `model.computedFields`) rather than a bare config, and accept an optional
 * `only` allow-list to restrict which computed fields are evaluated. With `only`
 * omitted, behavior is byte-identical to hono-crud (compute all configured).
 */

import type { ComputedFieldsConfig, Model } from './model.types';

/** Options for the computed-field appliers. */
export interface ApplyComputedFieldsOptions {
  /** Restrict evaluation to these computed-field names (allow-list). */
  only?: string[];
}

function selectComputedFields(
  computedFields: ComputedFieldsConfig | undefined,
  opts: ApplyComputedFieldsOptions,
): Array<[string, ComputedFieldsConfig[string]]> {
  if (!computedFields) return [];
  const entries = Object.entries(computedFields);
  if (!opts.only) return entries;
  const allow = new Set(opts.only);
  return entries.filter(([name]) => allow.has(name));
}

/**
 * Apply computed fields to a single record. Returns a NEW object with the
 * computed fields merged on; the original record is never mutated. Returns the
 * record unchanged (same reference) when there is nothing to compute.
 */
export async function applyComputedFields<T extends Record<string, unknown>>(
  model: Pick<Model, 'computedFields'>,
  record: T,
  opts: ApplyComputedFieldsOptions = {},
): Promise<Record<string, unknown>> {
  const selected = selectComputedFields(model.computedFields, opts);
  if (selected.length === 0) return record;

  const result: Record<string, unknown> = { ...record };
  for (const [fieldName, config] of selected) {
    try {
      result[fieldName] = await config.compute(record);
    } catch {
      // Computation failed — surface the field as undefined rather than 500.
      result[fieldName] = undefined;
    }
  }
  return result;
}

/**
 * Apply computed fields to an array of records (each independently). Returns
 * the array unchanged (same reference) when there is nothing to compute.
 */
export async function applyComputedFieldsToArray<T extends Record<string, unknown>>(
  model: Pick<Model, 'computedFields'>,
  records: T[],
  opts: ApplyComputedFieldsOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const selected = selectComputedFields(model.computedFields, opts);
  if (selected.length === 0) return records;
  return Promise.all(records.map((record) => applyComputedFields(model, record, opts)));
}
