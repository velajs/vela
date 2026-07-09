/**
 * Pagination: offset (page / per_page) and keyset (opaque cursor) modes.
 *
 * Ports hono-crud 0.13's `core/cursor.ts` (`encodeCursor` / `decodeCursor` /
 * `buildOffsetPageInfo` / `buildCursorPage`) and the offset clamping from
 * `parseListFilters`. Contracts preserved:
 *
 *  - **Defaults.** `per_page` defaults to 20, clamped to `[1, 100]`.
 *  - **Opaque cursor codec.** `btoa`/`atob` base64 (edge-safe — no Buffer).
 *  - **Next-only cursor walks (Stripe-style).** The cursor-mode `PageInfo` is
 *    exactly `{ page: 0, per_page, total_count?, has_next_page, has_prev_page,
 *    next_cursor? }` — no `total_pages`, no `prev_cursor`. `next_cursor`
 *    encodes the boundary (last returned) row's cursor field, present only when
 *    there is a next page.
 *
 * Divergence from hono-crud (tracked): `decodeCursor` still returns `null` on a
 * malformed cursor (source-faithful), but the engine-facing {@link resolveCursor}
 * throws {@link InputValidationException} instead of silently treating garbage
 * as page one — the native engine fails loud on bad client input.
 */

import { type PageInfo } from '../adapter/query-types';
import { InputValidationException } from '../envelope/errors';
import { type RawQuery } from './filters';

/** Default page size when `?per_page=` is absent. */
export const DEFAULT_PER_PAGE = 20;
/** Hard ceiling on `?per_page=` / `?limit=`. */
export const MAX_PER_PAGE = 100;
/** Default keyset column when none is configured. */
export const CURSOR_KEYSET_DEFAULT = 'id';

/**
 * `btoa`/`atob` are edge-runtime globals (present on Workers, Deno, browsers,
 * and Node >=18) but absent from the `ES2022` lib typings. Reference them
 * through a typed `globalThis` view so this module type-checks without pulling
 * the DOM lib into the shared config.
 */
const webBase64 = globalThis as unknown as {
  btoa: (data: string) => string;
  atob: (data: string) => string;
};

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
  return webBase64.btoa(String(value));
}

/**
 * Decode an opaque cursor string back to its original value. Returns `null`
 * when the input is not valid base64 (source-faithful — see
 * {@link resolveCursor} for the fail-loud engine seam).
 */
export function decodeCursor(cursor: string): string | null {
  try {
    return webBase64.atob(cursor);
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
    result_info.next_cursor = encodeCursor(boundary[cursorField] as string | number);
  }

  return { items, result_info };
}
