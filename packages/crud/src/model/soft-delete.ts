/**
 * Soft-delete helpers over the NORMALIZED {@link Model} (`softDeleteField` is
 * already resolved by `defineModel` — a `string` when enabled, `undefined`
 * when off). These back the `withDeleted` / `onlyDeleted` visibility semantics
 * the adapters and kernel apply uniformly.
 *
 * Parity note vs hono-crud 0.13 (`core/soft-delete.ts`): the normalization
 * (`getSoftDeleteConfig`) already happened in `defineModel`, so these operate
 * on the resolved field directly. `applyUpsertRestore` (match-and-restore) is
 * ported as-is.
 */

import type { FilterCondition } from '../adapter/query-types';
import type { Model } from './model.types';

/** The model's soft-delete column, or `undefined` when soft-delete is off. */
export function softDeleteFieldOf(model: Pick<Model, 'softDeleteField'>): string | undefined {
  return model.softDeleteField;
}

/** Whether a stored row is currently soft-deleted (its column is non-null). */
export function isSoftDeleted(
  model: Pick<Model, 'softDeleteField'>,
  row: Record<string, unknown>,
): boolean {
  const field = model.softDeleteField;
  if (!field) return false;
  return row[field] != null;
}

/** Soft-delete visibility flags carried on list/read options. */
export interface SoftDeleteVisibility {
  /** Include soft-deleted rows alongside live ones. */
  withDeleted?: boolean;
  /** Return ONLY soft-deleted rows. */
  onlyDeleted?: boolean;
}

/**
 * The {@link FilterCondition} enforcing soft-delete visibility for a query, or
 * `undefined` when no filter is needed (soft-delete off, or `withDeleted`).
 *
 *  - default (neither flag): `deletedAt IS NULL`  — live rows only
 *  - `onlyDeleted`:          `deletedAt IS NOT NULL` — deleted rows only
 *  - `withDeleted`:          no filter — everything
 *
 * `onlyDeleted` takes precedence over `withDeleted` when both are set.
 */
export function softDeleteVisibilityFilter(
  model: Pick<Model, 'softDeleteField'>,
  visibility: SoftDeleteVisibility = {},
): FilterCondition | undefined {
  const field = model.softDeleteField;
  if (!field) return undefined;
  if (visibility.onlyDeleted) {
    // `null` operator with value `false` ⇒ "field IS NOT NULL".
    return { field, operator: 'null', value: false };
  }
  if (visibility.withDeleted) return undefined;
  // `null` operator with value `true` ⇒ "field IS NULL".
  return { field, operator: 'null', value: true };
}

/**
 * In-memory predicate mirroring {@link softDeleteVisibilityFilter}: whether a
 * row is visible under the given visibility flags. Used by memory-style
 * adapters that filter rows directly rather than pushing a WHERE clause.
 */
export function isRowVisible(
  model: Pick<Model, 'softDeleteField'>,
  row: Record<string, unknown>,
  visibility: SoftDeleteVisibility = {},
): boolean {
  if (!model.softDeleteField) return true;
  const deleted = isSoftDeleted(model, row);
  if (visibility.onlyDeleted) return deleted;
  if (visibility.withDeleted) return true;
  return !deleted;
}

/**
 * Inject the soft-delete restore into upsert-family update data.
 *
 * Upsert-family endpoints MATCH soft-deleted rows and restore them on update
 * ("match-and-restore"). Treating a deleted row as absent would attempt a fresh
 * insert, hitting the unique constraint backing the upsert keys (SQL) or
 * silently duplicating a logical row (memory). Returns a NEW object when a
 * restore is applied, else the original `data` reference.
 */
export function applyUpsertRestore(
  model: Pick<Model, 'softDeleteField'>,
  data: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const field = model.softDeleteField;
  if (field && existing[field] != null) {
    return { ...data, [field]: null };
  }
  return data;
}
