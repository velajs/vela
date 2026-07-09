/**
 * Aggregate spec building + in-memory `computeAggregateFallback`.
 *
 * Full parity port of hono-crud 0.13's aggregate stack:
 *  - `core/aggregate.ts` `parseAggregateQuery` — multi-operation query parsing
 *    (`?count=*&sum=amount&avg=age`), `groupBy`, `having[alias][op]=value`,
 *    `orderBy`/`orderDirection`, and group `limit`/`offset`.
 *  - `endpoints/aggregate.ts` `validateAggregations` + `AGG_FIELD_RULES` —
 *    per-operation field allow-lists, groupBy allow-list + cardinality cap, and
 *    the group-limit ceiling.
 *  - `endpoints/aggregate.ts` `computeAggregations` + `getAggregateAlias` — the
 *    in-memory compute engine (group → per-op alias → HAVING → order → paginate)
 *    used when the adapter lacks the `aggregate` capability.
 *
 * Result shape mirrors hono-crud's {@link AggregateResult}: ungrouped queries
 * return `{ values }`; grouped queries return `{ groups, totalGroups }`.
 *
 * Aggregate WHERE filtering is NOT done here — for the native engine it is
 * pushed down through `adapter.list` (fallback) or `adapter.aggregate` (native)
 * with tenant scope + policy pushdown already merged, exactly like list/search.
 * `computeAggregateFallback` therefore receives an ALREADY-FILTERED row set and
 * only groups / aggregates / HAVINGs / orders / paginates (parity with
 * `computeAggregations`, which likewise never filters).
 */

import {
  AGGREGATE_OPERATIONS,
  type AggregateBucket,
  type AggregateField,
  type AggregateOperation,
  type AggregateResult,
  type AggregateSpec,
  type FilterCondition,
  type SortDirection,
} from '../adapter/query-types';
import { AggregationException } from '../envelope/errors';
import type { RawQuery } from './filters';

/** Per-operation field allow-lists + groupBy / group-limit constraints. */
export interface AggregateBuildConfig {
  sumFields?: string[];
  avgFields?: string[];
  minMaxFields?: string[];
  countDistinctFields?: string[];
  groupByFields?: string[];
  /** Maximum grouping dimensions per query. @default 5 */
  maxGroupByFields?: number;
  /** Default group-window size when `?limit=` is absent on a grouped query. @default 100 */
  defaultLimit?: number;
  /** Hard ceiling on a client-supplied `?limit=`. @default 1000 */
  maxLimit?: number;
}

/**
 * Per-operation field-restriction rules, exhaustive over `AggregateOperation`:
 * a newly-added operation cannot silently skip validation (it fails to compile
 * until given a rule). `null` means the operation has no per-field allow-list
 * (COUNT — always allowed, `COUNT(*)` and `COUNT(field)` alike).
 */
const AGG_FIELD_RULES = {
  count: null,
  sum: { config: 'sumFields', label: 'SUM' },
  avg: { config: 'avgFields', label: 'AVG' },
  min: { config: 'minMaxFields', label: 'MIN/MAX' },
  max: { config: 'minMaxFields', label: 'MIN/MAX' },
  countDistinct: { config: 'countDistinctFields', label: 'COUNT DISTINCT' },
} satisfies Record<
  AggregateOperation,
  { config: keyof AggregateBuildConfig; label: string } | null
>;

/** Comparison operators available in a HAVING clause (hono-crud parity). */
const COMPARISON_OPERATORS: Record<string, (value: number, threshold: number) => boolean> = {
  eq: (v, t) => v === t,
  ne: (v, t) => v !== t,
  gt: (v, t) => v > t,
  gte: (v, t) => v >= t,
  lt: (v, t) => v < t,
  lte: (v, t) => v <= t,
};

// ---------------------------------------------------------------------------
// Query-param parsing helpers
// ---------------------------------------------------------------------------

/** First value of a possibly-repeated query param. */
function first(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Parse the operation params into `AggregateField`s. Each operation is its own
 * query key whose value is the field (`?sum=amount`); a repeated param supplies
 * several fields for one operation. `'*'`, `'true'`, and `''` all mean
 * `COUNT(*)`-style (no field). Parity: a bare falsy value (`?count=`) is
 * skipped entirely — `handle()` injects the default `COUNT(*)` when nothing is
 * requested.
 */
function parseAggregations(query: RawQuery): AggregateField[] {
  const aggregations: AggregateField[] = [];
  for (const op of AGGREGATE_OPERATIONS) {
    const value = query[op];
    if (!value) continue;
    const fields = Array.isArray(value) ? value : [value];
    for (const field of fields) {
      if (typeof field !== 'string') continue;
      aggregations.push({ operation: op, field: field === 'true' || field === '' ? '*' : field });
    }
  }
  return aggregations;
}

/** Parse + validate `?groupBy=a,b` against the allow-list and cardinality cap. */
function parseGroupBy(query: RawQuery, config: AggregateBuildConfig): string[] | undefined {
  const raw = query.groupBy;
  let groupBy: string[] | undefined;
  if (typeof raw === 'string') {
    groupBy = raw.split(',').map((s) => s.trim());
  } else if (Array.isArray(raw)) {
    groupBy = raw.filter((s): s is string => typeof s === 'string');
  }
  if (!groupBy || groupBy.length === 0) return undefined;

  const maxGroupByFields = config.maxGroupByFields ?? 5;
  if (groupBy.length > maxGroupByFields) {
    throw new AggregationException(`Maximum ${maxGroupByFields} GROUP BY fields allowed`);
  }
  if (config.groupByFields && config.groupByFields.length > 0) {
    for (const field of groupBy) {
      if (!config.groupByFields.includes(field)) {
        throw new AggregationException(`Field '${field}' is not allowed for GROUP BY`);
      }
    }
  }
  return groupBy;
}

/** Parse `?having[alias][op]=value` into `{ alias: { op: threshold } }`. */
function parseHaving(query: RawQuery): Record<string, Record<string, string>> | undefined {
  let having: Record<string, Record<string, string>> | undefined;
  for (const [key, value] of Object.entries(query)) {
    const match = key.match(/^having\[(\w+)\]\[(\w+)\]$/);
    if (!match) continue;
    const alias = match[1];
    const op = match[2];
    const threshold = first(value);
    if (threshold === undefined) continue;
    if (!having) having = {};
    if (!having[alias]) having[alias] = {};
    having[alias][op] = threshold;
  }
  return having;
}

/** Parse a base-10 integer query param, or `undefined` when absent/garbage. */
function parseIntParam(raw: string | string[] | undefined): number | undefined {
  const value = first(raw);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Build a validated {@link AggregateSpec} from query params. `filters` are the
 * already-parsed (tenant-scoped, policy-pushed) WHERE conditions.
 *
 * @throws AggregationException on a disallowed aggregation field, a disallowed
 * or over-cardinality groupBy, or a limit above the ceiling.
 */
export function buildAggregateSpec(
  query: RawQuery,
  config: AggregateBuildConfig = {},
  filters: FilterCondition[] = [],
): AggregateSpec {
  const aggregations = parseAggregations(query);
  // Default to COUNT(*) when the caller requested nothing.
  if (aggregations.length === 0) {
    aggregations.push({ operation: 'count', field: '*' });
  }

  // Per-operation field allow-list (COUNT(*) is always allowed).
  for (const agg of aggregations) {
    if (agg.operation === 'count' && agg.field === '*') continue;
    const rule = AGG_FIELD_RULES[agg.operation];
    if (rule) {
      const allowed = config[rule.config] as string[] | undefined;
      if (allowed && allowed.length > 0 && !allowed.includes(agg.field)) {
        throw new AggregationException(
          `Field '${agg.field}' is not allowed for ${rule.label} aggregation`,
        );
      }
    }
  }

  const groupBy = parseGroupBy(query, config);
  const having = parseHaving(query);
  const orderBy = first(query.orderBy);
  const orderDirection: SortDirection = first(query.orderDirection) === 'desc' ? 'desc' : 'asc';
  let limit = parseIntParam(query.limit);
  const offset = parseIntParam(query.offset);

  // Validate a client-supplied limit BEFORE the grouped default is injected
  // (the injected default is always within the ceiling).
  const maxLimit = config.maxLimit ?? 1000;
  if (limit !== undefined && limit > maxLimit) {
    throw new AggregationException(`Limit cannot exceed ${maxLimit}`);
  }
  if (groupBy && groupBy.length > 0 && limit === undefined) {
    limit = config.defaultLimit ?? 100;
  }

  const head = aggregations[0];
  const spec: AggregateSpec = {
    operation: head.operation,
    aggregations,
    filters,
  };
  if (head.field !== '*') spec.field = head.field;
  if (groupBy) spec.groupBy = groupBy;
  if (having) spec.having = having;
  if (orderBy !== undefined) {
    spec.orderBy = orderBy;
    spec.orderDirection = orderDirection;
  }
  if (limit !== undefined) spec.limit = limit;
  if (offset !== undefined) spec.offset = offset;
  return spec;
}

// ---------------------------------------------------------------------------
// Aliasing + single-operation compute
// ---------------------------------------------------------------------------

/**
 * The output key for an aggregation. `COUNT(*)` → the bare operation name
 * (`count`); every other op camelCase-concatenates operation + field
 * (`sum` of `amount` → `sumAmount`, `avg` of `age` → `avgAge`, `countDistinct`
 * of `tag` → `countDistinctTag`). An explicit `alias` wins.
 */
export function getAggregateAlias(agg: AggregateField): string {
  if (agg.alias) return agg.alias;
  if (agg.field === '*') return agg.operation;
  return `${agg.operation}${agg.field.charAt(0).toUpperCase()}${agg.field.slice(1)}`;
}

function numericValues(rows: Array<Record<string, unknown>>, field: string): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const v = row[field];
    if (typeof v === 'number') out.push(v);
  }
  return out;
}

/** Compute one aggregation over a row set (empty ⇒ 0 for count, else null). */
function computeOne(rows: Array<Record<string, unknown>>, agg: AggregateField): number | null {
  if (rows.length === 0) {
    return agg.operation === 'count' ? 0 : null;
  }
  const field = agg.field;
  switch (agg.operation) {
    case 'count':
      return field === '*' ? rows.length : rows.filter((r) => r[field] != null).length;
    case 'countDistinct': {
      const unique = new Set(
        rows
          .map((r) => r[field])
          .filter((v) => v != null)
          .map((v) => String(v)),
      );
      return unique.size;
    }
    case 'sum': {
      let sum = 0;
      for (const v of numericValues(rows, field)) sum += v;
      return sum;
    }
    case 'avg': {
      const values = numericValues(rows, field);
      if (values.length === 0) return null;
      return values.reduce((a, b) => a + b, 0) / values.length;
    }
    case 'min': {
      const values = numericValues(rows, field);
      return values.length === 0 ? null : Math.min(...values);
    }
    case 'max': {
      const values = numericValues(rows, field);
      return values.length === 0 ? null : Math.max(...values);
    }
  }
}

/** The aggregations a spec runs — `aggregations` if present, else the legacy head. */
function specAggregations(spec: AggregateSpec): AggregateField[] {
  if (spec.aggregations && spec.aggregations.length > 0) return spec.aggregations;
  return [{ operation: spec.operation, field: spec.field ?? '*' }];
}

// ---------------------------------------------------------------------------
// In-memory compute (fallback for adapters without native aggregation)
// ---------------------------------------------------------------------------

/**
 * In-memory aggregate compute over an already-filtered row set. Mirrors
 * hono-crud's `computeAggregations`:
 *
 *  - no `groupBy` ⇒ `{ values: { <alias>: number|null } }`.
 *  - `groupBy` ⇒ group → per-op compute → HAVING → capture `totalGroups`
 *    (post-HAVING, pre-pagination) → order → limit/offset, returning
 *    `{ groups, totalGroups }`.
 *
 * Group-key columns are re-emitted as strings (the literal `'null'` decodes
 * back to `null`), matching the source's `join('|')` round-trip.
 */
export function computeAggregateFallback<T extends Record<string, unknown>>(
  rows: T[],
  spec: AggregateSpec,
): AggregateResult {
  const aggregations = specAggregations(spec);
  const groupBy = spec.groupBy;

  if (!groupBy || groupBy.length === 0) {
    const values: Record<string, number | null> = {};
    for (const agg of aggregations) values[getAggregateAlias(agg)] = computeOne(rows, agg);
    return { values };
  }

  // Group rows by the stringified groupBy key.
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = groupBy.map((f) => String(row[f] ?? 'null')).join('|');
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  let groupResults: AggregateBucket[] = [];
  for (const [keyStr, groupRows] of groups) {
    const parts = keyStr.split('|');
    const key: Record<string, unknown> = {};
    groupBy.forEach((f, i) => {
      key[f] = parts[i] === 'null' ? null : parts[i];
    });
    const values: Record<string, number | null> = {};
    for (const agg of aggregations) values[getAggregateAlias(agg)] = computeOne(groupRows, agg);
    groupResults.push({ key, values });
  }

  // HAVING: a null aggregate value passes (never filters); an unknown op is a
  // no-op (condition skipped).
  const having = spec.having;
  if (having) {
    groupResults = groupResults.filter((group) => {
      for (const [alias, conditions] of Object.entries(having)) {
        const value = group.values[alias];
        if (value === null || value === undefined) continue;
        for (const [op, threshold] of Object.entries(conditions)) {
          const compare = COMPARISON_OPERATORS[op];
          if (compare && !compare(value, Number(threshold))) return false;
        }
      }
      return true;
    });
  }

  const totalGroups = groupResults.length;

  if (spec.orderBy) {
    const orderBy = spec.orderBy;
    const direction = spec.orderDirection === 'desc' ? -1 : 1;
    groupResults.sort((a, b) => {
      if (orderBy in a.values) {
        const aVal = a.values[orderBy] ?? 0;
        const bVal = b.values[orderBy] ?? 0;
        return (aVal - bVal) * direction;
      }
      if (orderBy in a.key) {
        const aVal = String(a.key[orderBy] ?? '');
        const bVal = String(b.key[orderBy] ?? '');
        return aVal.localeCompare(bVal) * direction;
      }
      return 0;
    });
  }

  if (spec.offset !== undefined || spec.limit !== undefined) {
    const start = spec.offset ?? 0;
    const end = spec.limit ? start + spec.limit : undefined;
    groupResults = groupResults.slice(start, end);
  }

  return { groups: groupResults, totalGroups };
}
