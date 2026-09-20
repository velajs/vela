/** Offset metadata and engine-validated compound keyset pagination.
 * Tokens carry the entire ordered tuple (configured field plus primary keys).
 * Scalar encode/decode helpers are standalone utilities, not engine tokens.
 * Next-only walks retain page 0, optional totals and no total_pages/prev_cursor.
 */

import { type CursorValue, type Keyset, type PageInfo } from '../adapter/query-types';
import { InputValidationException } from '../envelope/errors';
import { type RawQuery } from './filters';

/** Default page size when `?per_page=` is absent. */
export const DEFAULT_PER_PAGE = 20;
/** Hard ceiling on `?per_page=` / `?limit=`. */
export const MAX_PER_PAGE = 100;
/** Default keyset column when none is configured. */
export const CURSOR_KEYSET_DEFAULT = 'id';

// ---------------------------------------------------------------------------
// Offset pagination
// ---------------------------------------------------------------------------

export interface OffsetPaginationOptions {
  defaultPerPage?: number;
  maxPerPage?: number;
}

export interface OffsetPagination {
  page: number;
  perPage: number;
}

/** First value of a possibly-repeated query param. */
function first(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return String(Array.isArray(raw) ? raw[0] : raw);
}

/**
 * Resolve `?page=` / `?per_page=` into a clamped `{ page, perPage }`. `page` is
 * at least 1; `perPage` is clamped to `[1, maxPerPage]`, defaulting to
 * `defaultPerPage` when absent or unparseable. Matches hono-crud's clamping.
 */
export function resolveOffsetPagination(
  params: RawQuery,
  options: OffsetPaginationOptions = {},
): OffsetPagination {
  const { defaultPerPage = DEFAULT_PER_PAGE, maxPerPage = MAX_PER_PAGE } = options;

  const pageRaw = first(params.page);
  const perPageRaw = first(params.per_page);

  const page = pageRaw === undefined ? 1 : Math.max(1, Number.parseInt(pageRaw, 10) || 1);
  const perPage =
    perPageRaw === undefined
      ? defaultPerPage
      : Math.min(maxPerPage, Math.max(1, Number.parseInt(perPageRaw, 10) || defaultPerPage));

  return { page, perPage };
}

/**
 * Build the offset-mode `PageInfo`:
 * `{ page, per_page, total_count, total_pages, has_next_page, has_prev_page }`.
 * `total_pages = ceil(totalCount / perPage)`, `has_next_page = page < total_pages`,
 * `has_prev_page = page > 1`. No `next_cursor` (that is cursor mode).
 */
export function buildOffsetPageInfo(page: number, perPage: number, totalCount: number): PageInfo {
  const totalPages = Math.ceil(totalCount / perPage);
  return {
    page,
    per_page: perPage,
    total_count: totalCount,
    total_pages: totalPages,
    has_next_page: page < totalPages,
    has_prev_page: page > 1,
  };
}

// ---------------------------------------------------------------------------
// Keyset (cursor) pagination
// ---------------------------------------------------------------------------

/** Encode a cursor value to an opaque base64 string (edge-safe `btoa`). */
export function encodeCursor(value: string | number): string {
  return btoa(String(value));
}

/**
 * Decode an opaque cursor string back to its original value. Returns `null`
 * when the input is not valid base64 (source-faithful — see
 * {@link resolveCursor} for the fail-loud engine seam).
 */
export function decodeCursor(cursor: string): string | null {
  try {
    return atob(cursor);
  } catch {
    return null;
  }
}

/**
 * Decode a cursor for the engine, throwing {@link InputValidationException} on a
 * malformed value instead of returning `null`. Use at the request boundary so a
 * garbage `?cursor=` fails loud rather than silently restarting the walk.
 */
export function resolveCursor(cursor: string): string {
  const decoded = decodeCursor(cursor);
  if (decoded === null) {
    throw new InputValidationException('Invalid cursor');
  }
  return decoded;
}

export interface CursorPageInfoOptions {
  /** Total rows matching the filters (without the cursor window). Included in the envelope when provided. */
  totalCount?: number;
  /** Whether a decoded cursor was applied to this query (i.e. not page one). */
  cursorApplied?: boolean;
}

/** Trimmed cursor page: the visible rows plus the cursor-mode `PageInfo`. */
export interface CursorPageResult<T> {
  items: T[];
  result_info: PageInfo;
}

/**
 * Build the cursor-mode page from an overfetched keyset window.
 *
 * The adapter fetches `perPageLimit + 1` rows ordered ascending by the cursor
 * field; the surplus row proves there is a next page and is trimmed here.
 * `next_cursor` encodes the boundary (last returned) row's cursor field, and is
 * present only when a next page exists. The envelope is next-only: `page` is 0,
 * there is no `total_pages` and no `prev_cursor`; `has_prev_page` reflects
 * whether a cursor was applied. `total_count` is included only when supplied.
 */
export function buildCursorPageInfo<T extends Record<string, unknown>>(
  perPageLimit: number,
  rows: T[],
  cursorField: string,
  options: CursorPageInfoOptions = {},
): CursorPageResult<T> {
  const { totalCount, cursorApplied = false } = options;

  const hasNextPage = rows.length > perPageLimit;
  const items = hasNextPage ? rows.slice(0, perPageLimit) : rows;
  const boundary = items[items.length - 1];

  const result_info: PageInfo = {
    page: 0,
    per_page: perPageLimit,
    has_next_page: hasNextPage,
    has_prev_page: cursorApplied,
  };
  if (totalCount !== undefined) {
    result_info.total_count = totalCount;
  }
  if (hasNextPage && boundary !== undefined) {
    result_info.next_cursor = encodeCursor(String(boundary[cursorField]));
  }

  return { items, result_info };
}

/** Versioned compound cursors bind the token to its complete ordering. */
export function encodeKeyset(keyset: Keyset, row: Record<string, unknown>): string {
  const values = keyset.fields.map((field) => cursorValue(row[field]));
  const payload = JSON.stringify({
    v: 1,
    fields: keyset.fields,
    direction: keyset.direction,
    values: values.map((value) => (value instanceof Date ? { date: value.toISOString() } : value)),
  });
  return btoa(
    Array.from(new TextEncoder().encode(payload), (byte) => String.fromCharCode(byte)).join(''),
  );
}

export function cursorValue(value: unknown): CursorValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  throw new InputValidationException('Cursor fields must contain finite scalar values or dates');
}

function decodeValue(value: unknown): CursorValue {
  if (
    typeof value === 'object' &&
    value !== null &&
    'date' in value &&
    typeof value.date === 'string'
  ) {
    return cursorValue(new Date(value.date));
  }
  return cursorValue(value);
}

export function resolveKeyset(
  cursor: string | undefined,
  fields: string[],
  direction: 'asc' | 'desc',
): Keyset {
  const keyset: Keyset = { fields, direction };
  if (cursor === undefined) return keyset;
  try {
    if (cursor.length === 0 || cursor.length > 16384) throw new Error('Invalid length');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(cursor), (char) => char.charCodeAt(0)),
    );
    const value: unknown = JSON.parse(json);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('v' in value) ||
      value.v !== 1 ||
      !('fields' in value) ||
      !Array.isArray(value.fields) ||
      value.fields.length !== fields.length ||
      !value.fields.every((field, index) => field === fields[index]) ||
      !('direction' in value) ||
      value.direction !== direction ||
      !('values' in value) ||
      !Array.isArray(value.values) ||
      value.values.length !== fields.length
    ) {
      throw new Error('Invalid shape or order');
    }
    keyset.after = value.values.map(decodeValue);
    return keyset;
  } catch {
    throw new InputValidationException('Invalid cursor');
  }
}

/** Identical null-first ascending / null-last descending order across adapters. */
export function compareCursorValues(left: CursorValue, right: CursorValue): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareKeysetRows(
  keyset: Keyset,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  for (const field of keyset.fields) {
    const result = compareCursorValues(cursorValue(left[field]), cursorValue(right[field]));
    if (result) return keyset.direction === 'asc' ? result : -result;
  }
  return 0;
}

export function isAfterKeyset(keyset: Keyset, row: Record<string, unknown>): boolean {
  if (keyset.after === undefined) return true;
  for (const [index, field] of keyset.fields.entries()) {
    const result = compareCursorValues(cursorValue(row[field]), keyset.after[index]);
    if (result) return keyset.direction === 'asc' ? result > 0 : result < 0;
  }
  return false;
}

export function buildKeysetPage<T extends Record<string, unknown>>(
  limit: number,
  rows: T[],
  keyset: Keyset,
  totalCount?: number,
): { result: T[]; result_info: PageInfo } {
  const result = rows.slice(0, limit);
  const last = result.at(-1);
  const hasNext = rows.length > limit;
  return {
    result,
    result_info: {
      page: 0,
      per_page: limit,
      total_count: totalCount,
      has_next_page: hasNext,
      has_prev_page: keyset.after !== undefined,
      ...(hasNext && last ? { next_cursor: encodeKeyset(keyset, last) } : {}),
    },
  };
}
