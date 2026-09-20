import type { FilterCondition } from '@velajs/crud/adapter';

/**
 * Fail-closed guard for unknown operators: query input is untrusted, and a
 * silently-disabled filter would return every record (a data-exposure
 * footgun). Typed `never` so a new `FilterOperator` member is a build error
 * here until handled.
 */
function unknownOperator(_operator: never): false {
  return false;
}

/**
 * Evaluates one filter condition against an already-extracted field value —
 * the single source of truth for the memory adapter's operator semantics
 * (list / export / bulk-patch share it so they cannot drift).
 *
 * like/ilike follow the cross-adapter literal-needle contract: the user value
 * is a literal substring — `%` is stripped, `_` is inert. `like` is
 * case-sensitive in memory (collation-strict); `ilike` is case-insensitive.
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
      return String(value).includes(String(filter.value).replace(/%/g, ''));
    case 'ilike':
      return String(value)
        .toLowerCase()
        .includes(String(filter.value).replace(/%/g, '').toLowerCase());
    case 'null':
      return filter.value ? value == null : value != null;
    case 'between': {
      const [min, max] = filter.value as [unknown, unknown];
      return Number(value) >= Number(min) && Number(value) <= Number(max);
    }
    default:
      return unknownOperator(filter.operator);
  }
}
