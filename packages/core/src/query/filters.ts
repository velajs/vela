/**
 * Query-string filter parsing + in-memory operator evaluation.
 *
 * Ports hono-crud 0.13's `parseListFilters` / `parseFilterValue`
 * (endpoints/types.ts) and the in-memory `matchesFilter` operator switch
 * (packages/memory/src/filter.ts) onto the native engine's `FilterCondition` /
 * `ListQuery` shapes. Two cross-adapter contracts are preserved verbatim:
 *
 *  - **Fail-closed operators/fields.** An unknown bracket operator or a field
 *    that is not allow-listed is silently dropped (never forged into an invalid
 *    operator that a downstream adapter ignores, disabling the filter and
 *    returning every row). `matchesFilter` likewise returns `false` for an
 *    operator outside the closed union rather than matching everything.
 *  - **Literal-needle like/ilike.** The user value is a literal substring
 *    needle — `%` is stripped, `_` is inert — never a live SQL wildcard.
 *    `normalizeNeedle` is the shared implementation adapters import.
 */

import {
  type FilterCondition,
  type FilterConfig,
  type FilterOperator,
  type ListOptions,
  type ListQuery,
  type SortDirection,
  isFilterOperator,
} from '../adapter/query-types';

// ---------------------------------------------------------------------------
// Literal-needle contract (like / ilike)
// ---------------------------------------------------------------------------

/**
 * Normalize a user-supplied substring needle for `like`/`ilike`. The needle is
 * matched literally: SQL `%` wildcards are stripped and `_` is left inert (a
 * literal underscore, never a single-char wildcard). Exported so every adapter
 * shares one definition of the substring-match contract.
 *
 * @example normalizeNeedle('50%')      // '50'
 * @example normalizeNeedle('foo_bar')  // 'foo_bar'  ( `_` stays literal )
 * @example normalizeNeedle('a%b%c')    // 'abc'
 */
export function normalizeNeedle(value: string): string {
  return value.replace(/%/g, '');
}

// ---------------------------------------------------------------------------
// Value coercion + single-value parsing
// ---------------------------------------------------------------------------

/**
 * Coerce a raw filter value string based on operator type. Array operators
 * (`in`, `nin`, `between`) split on commas and trim; `null` coerces to boolean.
 */
export function coerceFilterValue(operator: FilterOperator, raw: string): unknown {
  if (operator === 'in' || operator === 'nin' || operator === 'between') {
    return raw.split(',').map((v) => v.trim());
  }
  if (operator === 'null') {
    return raw.toLowerCase() === 'true';
  }
  return raw;
}

/**
 * Parse a single query-string filter value such as `[gte]30` into an operator +
 * coerced value. An unrecognized bracket token (e.g. `[foo]bar`) is NOT cast
 * blindly — it falls through to literal equality so it cannot act as an
 * operator (fail-closed, hono-crud regression parity).
 */
export function parseFilterValue(value: string): { operator: FilterOperator; value: unknown } {
  const operatorMatch = value.match(/^\[([a-z]+)\](.*)$/);
  if (operatorMatch && isFilterOperator(operatorMatch[1])) {
    const operator = operatorMatch[1];
    return { operator, value: coerceFilterValue(operator, operatorMatch[2]) };
  }
  return { operator: 'eq', value };
}

// ---------------------------------------------------------------------------
// In-memory operator evaluation (engine fallback + memory adapters)
// ---------------------------------------------------------------------------

/**
 * Fail-closed guard: the only way an operator outside the closed
 * `FilterOperator` union reaches the `matchesFilter` default is a forged
 * `FilterCondition` from untrusted input. Matching nothing (return `false`) is
 * safe; the old `default: true` silently disabled the filter and exposed every
 * row.
 */
function unknownOperator(_operator: never): false {
  return false;
}

/**
 * Evaluate one {@link FilterCondition} against an already-extracted field value
 * using the engine's in-memory semantics. Single source of truth for operator
 * handling in the memory adapter and in the search / aggregate fallbacks.
 */
export function matchesFilter(value: unknown, filter: FilterCondition): boolean {
  switch (filter.operator) {
    case 'eq':
      return String(value) === String(filter.value);
    case 'ne':
      return String(value) !== String(filter.value);
    case 'gt':
      return Number(value) > Number(filter.value);
    case 'gte':
      return Number(value) >= Number(filter.value);
    case 'lt':
      return Number(value) < Number(filter.value);
    case 'lte':
      return Number(value) <= Number(filter.value);
    case 'in':
      return (filter.value as unknown[]).map(String).includes(String(value));
    case 'nin':
      return !(filter.value as unknown[]).map(String).includes(String(value));
    case 'like':
      return String(value).includes(normalizeNeedle(String(filter.value)));
    case 'ilike':
      return String(value)
        .toLowerCase()
        .includes(normalizeNeedle(String(filter.value)).toLowerCase());
    case 'null':
      return filter.value ? value === null : value !== null;
    case 'between': {
      const [min, max] = filter.value as [unknown, unknown];
      return Number(value) >= Number(min) && Number(value) <= Number(max);
    }
    default:
      return unknownOperator(filter.operator);
  }
}

/** Keep rows matching every condition (empty condition set keeps all rows). */
export function applyFilters<T extends Record<string, unknown>>(
  rows: T[],
  filters: FilterCondition[],
): T[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.every((f) => matchesFilter(row[f.field], f)));
}

// ---------------------------------------------------------------------------
// List query-string parsing
// ---------------------------------------------------------------------------

/** Raw query params: a single value or a repeated (array) value per key. */
export type RawQuery = Record<string, string | string[] | undefined>;

/**
 * Runtime parse options for {@link parseListFilters} (distinct from the
 * declarative author-facing list config). Mirrors hono-crud's
 * `ListFilterParseOptions`.
 */
export interface ParseListQueryOptions {
  // Filtering
  filterFields?: string[];
  filterConfig?: FilterConfig;

  // Search
  searchFields?: string[];
  searchParamName?: string;

  // Sorting
  sortFields?: string[];
  defaultSort?: { field: string; order: SortDirection };

  // Offset pagination
  defaultPerPage?: number;
  maxPerPage?: number;

  // Cursor pagination
  cursorPaginationEnabled?: boolean;
  cursorField?: string;

  // Soft delete
  softDeleteQueryParam?: string;

  // Relations
  allowedIncludes?: string[];

  // Field selection
  fieldSelectionEnabled?: boolean;
  allowedSelectFields?: string[];
  blockedSelectFields?: string[];
  alwaysIncludeFields?: string[];
  defaultSelectFields?: string[];
}

/** Reserved query params that are consumed as options, never as filters. */
export const RESERVED_LIST_PARAMS = [
  'page',
  'per_page',
  'sort',
  'order',
  'search',
  'include',
  'fields',
  'cursor',
  'limit',
  'withDeleted',
  'onlyDeleted',
] as const;

/** First value of a possibly-repeated query param, coerced to string. */
function firstString(raw: string | string[]): string {
  return String(Array.isArray(raw) ? raw[0] : raw);
}

/**
 * Parse raw query params into the validated {@link ListQuery} handed to
 * `CrudAdapter.list`: allow-listed, operator-validated `FilterCondition[]` plus
 * the accompanying {@link ListOptions}. Faithful port of hono-crud
 * `parseListFilters` — same reserved-param routing, same fail-closed filter
 * allow-listing, same clamping and cursor-mode ordering override.
 */
export function parseListFilters(query: RawQuery, config: ParseListQueryOptions = {}): ListQuery {
  const filters: FilterCondition[] = [];
  const options: ListOptions = {};

  const {
    filterFields = [],
    filterConfig = {},
    searchFields = [],
    searchParamName = 'search',
    sortFields = [],
    defaultSort,
    defaultPerPage = 20,
    maxPerPage = 100,
    cursorPaginationEnabled = false,
    cursorField,
    softDeleteQueryParam = 'withDeleted',
    allowedIncludes = [],
    fieldSelectionEnabled = false,
    allowedSelectFields = [],
    blockedSelectFields = [],
    alwaysIncludeFields = [],
    defaultSelectFields = [],
  } = config;

  // Build the per-field operator allow-list: bare `filterFields` allow only
  // `eq`; `filterConfig` entries override with an explicit operator list.
  const allowedFilters: FilterConfig = {};
  for (const field of filterFields) {
    allowedFilters[field] = ['eq'];
  }
  Object.assign(allowedFilters, filterConfig);

  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null) continue;

    const value = firstString(rawValue);

    // Cursor pagination
    if (cursorPaginationEnabled && key === 'cursor') {
      options.cursor = value;
      continue;
    }
    if (cursorPaginationEnabled && key === 'limit') {
      options.limit = Math.min(maxPerPage, Math.max(1, Number.parseInt(value, 10) || defaultPerPage));
      continue;
    }

    // Offset pagination
    if (key === 'page') {
      options.page = Math.max(1, Number.parseInt(value, 10) || 1);
      continue;
    }
    if (key === 'per_page') {
      options.per_page = Math.min(maxPerPage, Math.max(1, Number.parseInt(value, 10) || defaultPerPage));
      continue;
    }

    // Sorting (?sort=field&order=asc|desc)
    if (key === 'sort') {
      if (sortFields.length === 0 || sortFields.includes(value)) {
        options.order_by = value;
      }
      continue;
    }
    if (key === 'order') {
      if (value === 'asc' || value === 'desc') {
        options.order_by_direction = value;
      }
      continue;
    }

    // Search
    if (key === searchParamName && searchFields.length > 0) {
      options.search = value;
      continue;
    }

    // Soft delete
    if (key === softDeleteQueryParam) {
      options.withDeleted = value.toLowerCase() === 'true';
      continue;
    }
    if (key === 'onlyDeleted') {
      options.onlyDeleted = value.toLowerCase() === 'true';
      continue;
    }

    // Relation includes
    if (key === 'include') {
      const requested = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      options.include =
        allowedIncludes.length > 0 ? requested.filter((r) => allowedIncludes.includes(r)) : requested;
      continue;
    }

    // Field selection
    if (key === 'fields' && fieldSelectionEnabled) {
      const requested = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      let selected = requested;
      if (allowedSelectFields.length > 0) {
        selected = selected.filter((f) => allowedSelectFields.includes(f));
      }
      if (blockedSelectFields.length > 0) {
        selected = selected.filter((f) => !blockedSelectFields.includes(f));
      }
      if (alwaysIncludeFields.length > 0) {
        selected = [...new Set([...alwaysIncludeFields, ...selected])];
      }
      options.fields = selected;
      continue;
    }

    // Filters with bracket syntax: field[operator]=value
    const bracketMatch = key.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-z]+)\]$/);
    if (bracketMatch) {
      const field = bracketMatch[1];
      const operator = bracketMatch[2] as FilterOperator;
      // Fail-closed: `allowedFilters` only ever holds real operators, so an
      // unknown operator (or an unallowed field) simply drops.
      if (allowedFilters[field]?.includes(operator)) {
        filters.push({ field, operator, value: coerceFilterValue(operator, value) });
      }
      continue;
    }

    // Simple field=value → equality (fail-closed on unallowed field).
    if (allowedFilters[key]) {
      filters.push({ field: key, operator: 'eq', value });
    }
  }

  // Defaults
  if (!options.page) options.page = 1;
  if (!options.per_page) options.per_page = defaultPerPage;
  if (!options.order_by && defaultSort?.field) options.order_by = defaultSort.field;
  if (!options.order_by_direction) options.order_by_direction = defaultSort?.order ?? 'asc';

  // Cursor-mode ordering contract: a cursor walk forces ORDER BY the cursor
  // field ascending; user sort/order are ignored (keyset pagination is only
  // correct on that order).
  if (cursorPaginationEnabled && (options.cursor !== undefined || options.limit !== undefined)) {
    options.order_by = cursorField ?? 'id';
    options.order_by_direction = 'asc';
  }

  // Default field selection when enabled and no `?fields=` was supplied.
  if (fieldSelectionEnabled && !options.fields && defaultSelectFields.length > 0) {
    let selected = [...defaultSelectFields];
    if (alwaysIncludeFields.length > 0) {
      selected = [...new Set([...alwaysIncludeFields, ...selected])];
    }
    options.fields = selected;
  }

  return { filters, options };
}
