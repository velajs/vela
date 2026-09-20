/**
 * The data browser's ENTIRE view state, serialized to the URL search params:
 * the link IS the query. `DataViewSearch` is the flat, URL-facing shape (what
 * the router's `validateSearch` stores and `useSearch` returns); `DataView` is
 * the rich in-panel shape the grid/toolbar operate on. The two codecs round-trip
 * losslessly through `toDataView` / `toSearch`, and `toListRowsRequest` projects
 * a view onto the `data.listRows` wire request.
 */
import type { ListRowsRequest, StudioGridFilter } from '@velajs/studio-protocol';
import { STUDIO_FILTER_OPERATORS } from '@velajs/studio-protocol';

/** Sort direction, encoded in the URL as `field:asc` / `field:desc`. */
export type SortOrder = 'asc' | 'desc';

/** The rich, in-panel view state. */
export interface DataView {
  model: string | null;
  search: string;
  page: number;
  perPage: number;
  sort: { field: string; order: SortOrder } | null;
  filters: StudioGridFilter[];
  withDeleted: boolean;
}

/** The flat, URL-facing search shape (all optional; defaults are omitted). */
export interface DataViewSearch {
  model?: string;
  q?: string;
  page?: number;
  perPage?: number;
  sort?: string;
  filters?: string;
  del?: boolean;
}

export const DEFAULT_PER_PAGE = 25;

export const DEFAULT_DATA_VIEW: DataView = {
  model: null,
  search: '',
  page: 1,
  perPage: DEFAULT_PER_PAGE,
  sort: null,
  filters: [],
  withDeleted: false,
};

const OPERATORS = new Set<string>(STUDIO_FILTER_OPERATORS);

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Normalize a raw (possibly string-valued) search object into `DataViewSearch`.
 * Used as the data route's `validateSearch`, so every URL param is coerced to a
 * stable, typed primitive and unknown keys are dropped.
 */
export function decodeDataViewSearch(raw: unknown): DataViewSearch {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: DataViewSearch = {};
  const model = coerceString(source.model);
  if (model !== undefined) out.model = model;
  const q = coerceString(source.q);
  if (q !== undefined) out.q = q;
  const page = coerceNumber(source.page);
  if (page !== undefined && page > 1) out.page = page;
  const perPage = coerceNumber(source.perPage);
  if (perPage !== undefined) out.perPage = perPage;
  const sort = coerceString(source.sort);
  if (sort !== undefined) out.sort = sort;
  const filters = coerceString(source.filters);
  if (filters !== undefined) out.filters = filters;
  const del = coerceBool(source.del);
  if (del === true) out.del = true;
  return out;
}

function parseSort(raw: string | undefined): DataView['sort'] {
  if (raw === undefined) return null;
  const idx = raw.lastIndexOf(':');
  if (idx <= 0) return null;
  const field = raw.slice(0, idx);
  const order = raw.slice(idx + 1);
  if (order !== 'asc' && order !== 'desc') return null;
  return { field, order };
}

function isGridFilter(value: unknown): value is StudioGridFilter {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.field === 'string' &&
    typeof candidate.operator === 'string' &&
    OPERATORS.has(candidate.operator) &&
    'value' in candidate
  );
}

function parseFilters(raw: string | undefined): StudioGridFilter[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isGridFilter);
  } catch {
    return [];
  }
}

/** Expand a flat `DataViewSearch` into the rich `DataView`. */
export function toDataView(search: DataViewSearch): DataView {
  return {
    model: search.model ?? null,
    search: search.q ?? '',
    page: search.page !== undefined && search.page > 1 ? search.page : 1,
    perPage: search.perPage ?? DEFAULT_PER_PAGE,
    sort: parseSort(search.sort),
    filters: parseFilters(search.filters),
    withDeleted: search.del ?? false,
  };
}

/** Collapse a rich `DataView` back to the minimal URL-facing search (defaults dropped). */
export function toSearch(view: DataView): DataViewSearch {
  const out: DataViewSearch = {};
  if (view.model !== null) out.model = view.model;
  if (view.search !== '') out.q = view.search;
  if (view.page > 1) out.page = view.page;
  if (view.perPage !== DEFAULT_PER_PAGE) out.perPage = view.perPage;
  if (view.sort !== null) out.sort = `${view.sort.field}:${view.sort.order}`;
  if (view.filters.length > 0) out.filters = JSON.stringify(view.filters);
  if (view.withDeleted) out.del = true;
  return out;
}

/** Project a view onto the `data.listRows` wire request for the active model. */
export function toListRowsRequest(view: DataView, model: string): ListRowsRequest {
  const request: ListRowsRequest = { model, page: view.page, perPage: view.perPage };
  if (view.search !== '') request.search = view.search;
  if (view.sort !== null) request.sort = view.sort;
  if (view.filters.length > 0) request.filters = view.filters;
  if (view.withDeleted) request.withDeleted = true;
  return request;
}
