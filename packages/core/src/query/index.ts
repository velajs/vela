/**
 * Query layer barrel: filter parsing + operator evaluation, sort resolution,
 * field selection, offset/keyset pagination, search scoring + fallback, and
 * aggregate spec building + fallback. Ports hono-crud 0.13 behavior onto the
 * native engine's `../adapter/query-types` contracts.
 */

export {
  applyFilters,
  coerceFilterValue,
  matchesFilter,
  normalizeNeedle,
  parseFilterValue,
  parseListFilters,
  RESERVED_LIST_PARAMS,
  type ParseListQueryOptions,
  type RawQuery,
} from './filters';

export { resolveSort, type ResolveSortOptions } from './sort';

export {
  applyFieldSelection,
  applyFieldSelectionToArray,
  parseFieldSelection,
  type FieldSelection,
  type FieldSelectionConfig,
} from './field-selection';

export {
  buildCursorPageInfo,
  buildOffsetPageInfo,
  CURSOR_KEYSET_DEFAULT,
  decodeCursor,
  DEFAULT_PER_PAGE,
  encodeCursor,
  MAX_PER_PAGE,
  resolveCursor,
  resolveOffsetPagination,
  type CursorPageInfoOptions,
  type CursorPageResult,
  type OffsetPagination,
  type OffsetPaginationOptions,
} from './pagination';

export {
  calculateScore,
  generateHighlights,
  parseSearchMode,
  runSearchFallback,
  termFrequency,
  tokenize,
  tokenizeQuery,
  type SearchFieldConfig,
} from './search';

export {
  buildAggregateSpec,
  computeAggregateFallback,
  type AggregateBuildConfig,
} from './aggregate';
