/**
 * Sort resolution from `?sort=<field>&order=<asc|desc>` query params.
 *
 * Ports hono-crud 0.13's inline sort handling (endpoints/types.ts
 * `parseListFilters` + endpoints/list.ts): the query param names are `sort`
 * (the field) and `order` (the direction) — locked by test. The field is
 * allow-listed against `sortFields` (empty = accept any); the direction is
 * validated against `asc`/`desc`; both fall back to `defaultSort`.
 */

import { type SortDirection, type SortSpec } from '../adapter/query-types';
import { type RawQuery } from './filters';

export interface ResolveSortOptions {
  /** Allow-list of sortable fields. Empty/omitted accepts any `sort` value. */
  sortFields?: string[];
  /** Fallback field + direction when the request omits (or fails) `sort`. */
  defaultSort?: SortSpec;
}

/** First value of a possibly-repeated query param. */
function first(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return String(Array.isArray(raw) ? raw[0] : raw);
}

/**
 * Resolve the effective sort for a list request.
 *
 * - `?sort=<field>` is honored only when `sortFields` is empty or includes it;
 *   otherwise it is ignored and `defaultSort.field` (if any) is used.
 * - `?order=<asc|desc>` is honored only when it is exactly `asc` or `desc`;
 *   otherwise the direction falls back to `defaultSort.order ?? 'asc'`.
 *
 * Returns `undefined` when no field is resolvable (no valid `sort` and no
 * `defaultSort.field`) — the adapter then applies its own default ordering.
 */
export function resolveSort(params: RawQuery, options: ResolveSortOptions = {}): SortSpec | undefined {
  const { sortFields = [], defaultSort } = options;

  const sortParam = first(params.sort);
  const orderParam = first(params.order);

  let field: string | undefined;
  if (sortParam !== undefined && (sortFields.length === 0 || sortFields.includes(sortParam))) {
    field = sortParam;
  } else if (defaultSort?.field) {
    field = defaultSort.field;
  }

  if (field === undefined) return undefined;

  const order: SortDirection =
    orderParam === 'asc' || orderParam === 'desc' ? orderParam : (defaultSort?.order ?? 'asc');

  return { field, order };
}
