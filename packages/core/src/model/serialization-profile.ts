/**
 * Apply a model's serialization profile to outgoing records: every `exclude`d
 * field is REMOVED from the response object (`'field' in record === false` —
 * hono-crud 0.13 finalize-pipeline parity), unlike a policy mask, which
 * redacts a value in place. Response-only: storage, filters, sorting, hooks,
 * and version/audit snapshots all see the full row.
 */

import type { Model } from './model.types';

type HasProfile = Pick<Model, 'serializationProfile'>;

/**
 * Strip the profile's excluded fields from one record. Returns a NEW object;
 * the input is never mutated. Returns the record unchanged (same reference)
 * when no exclusions are configured or none are present on the record.
 */
export function applyProfile<T extends Record<string, unknown>>(
  model: HasProfile,
  record: T,
): T {
  const exclude = model.serializationProfile?.exclude;
  if (!exclude || exclude.length === 0) return record;
  if (!exclude.some((field) => field in record)) return record;
  const out: Record<string, unknown> = { ...record };
  for (const field of exclude) delete out[field];
  return out as T;
}

/** Array variant of {@link applyProfile} (each record independently). */
export function applyProfileToArray<T extends Record<string, unknown>>(
  model: HasProfile,
  records: T[],
): T[] {
  const exclude = model.serializationProfile?.exclude;
  if (!exclude || exclude.length === 0) return records;
  return records.map((record) => applyProfile(model, record));
}
