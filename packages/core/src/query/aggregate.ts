/**
 * Aggregate spec building + in-memory `computeAggregateFallback`.
 *
 * Ports hono-crud 0.13's aggregate validation (`endpoints/aggregate.ts`
 * `validateAggregations` + `AGG_FIELD_RULES`) and the in-memory compute engine
 * (`computeAggregations`) onto the native engine's single-operation
 * {@link AggregateSpec} / {@link AggregateResult} (`{ buckets }`) shapes.
 *
 * Validation fails loud with {@link AggregationException} on: an unknown
 * operation, a missing field for an operation that requires one, a field
 * outside its per-operation allow-list, a `groupBy` field outside the groupBy
 * allow-list, or more than `maxGroupByFields` grouping dimensions.
 *
 * Divergence from hono-crud (tracked): the native `AggregateSpec` is a SINGLE
 * operation and carries no `having` / `orderBy` / `limit` / `offset`, so the
 * multi-aggregation-per-query, HAVING, group ordering, and group pagination
 * features of `computeAggregations` are intentionally out of scope here.
 */

import {
  AGGREGATE_OPERATIONS,
  type AggregateOperation,
  type AggregateResult,
  type AggregateSpec,
  type FilterCondition,
} from '../adapter/query-types';
import { AggregationException } from '../envelope/errors';
import { applyFilters, type RawQuery } from './filters';

/** Per-operation field allow-lists + groupBy constraints. */
export interface AggregateBuildConfig {
  sumFields?: string[];
  avgFields?: string[];
  minMaxFields?: string[];
  countDistinctFields?: string[];
  groupByFields?: string[];
  /** Maximum grouping dimensions per query. @default 5 */
  maxGroupByFields?: number;
}

/**
 * Per-operation field-restriction rules, exhaustive over `AggregateOperation`:
 * a newly-added operation cannot silently skip validation (it fails to compile
 * until given a rule). `null` means the operation requires no field allow-list
 * — and, here, no field at all (COUNT).
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

/** First value of a possibly-repeated query param. */
function first(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return String(Array.isArray(raw) ? raw[0] : raw);
}

/** Normalize a raw operation token (case-insensitive) to a canonical op, or null. */
function normalizeOperation(raw: string): AggregateOperation | null {
  const lower = raw.toLowerCase();
  const match = AGGREGATE_OPERATIONS.find((op) => op.toLowerCase() === lower);
  return match ?? null;
}

/**
 * Build a validated {@link AggregateSpec} from query params
 * (`?operation=<op>&field=<f>&groupBy=a,b`). `count` may omit the field (or pass
 * `*`) for COUNT(*); every other operation requires a field. `filters` are the
 * already-parsed WHERE conditions (default none).
 *
 * @throws AggregationException on invalid operation / field / groupBy input.
 */
export function buildAggregateSpec(
  query: RawQuery,
  config: AggregateBuildConfig = {},
  filters: FilterCondition[] = [],
): AggregateSpec {
  const rawOperation = first(query.operation);
  if (!rawOperation) {
    throw new AggregationException('Aggregate operation is required');
  }

  const operation = normalizeOperation(rawOperation);
  if (operation === null) {
    throw new AggregationException(`Unknown aggregate operation '${rawOperation}'`);
  }

  const rawField = first(query.field);
  let field: string | undefined = rawField && rawField !== '*' ? rawField : undefined;

  const rule = AGG_FIELD_RULES[operation];
  if (rule) {
    // Operations other than COUNT require a concrete field.
    if (!field) {
      throw new AggregationException(`Field is required for ${rule.label} aggregation`);
    }
    const allowed = config[rule.config] as string[] | undefined;
    if (allowed && allowed.length > 0 && !allowed.includes(field)) {
      throw new AggregationException(`Field '${field}' is not allowed for ${rule.label} aggregation`);
    }
  } else {
    // COUNT: field is optional; a bare field means COUNT(field) (non-null count).
    field = rawField && rawField !== '*' ? rawField : undefined;
  }

  // groupBy
  const rawGroupBy = first(query.groupBy);
  let groupBy: string[] | undefined;
  if (rawGroupBy) {
    const parsed = rawGroupBy
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length > 0) {
      const maxGroupByFields = config.maxGroupByFields ?? 5;
      if (parsed.length > maxGroupByFields) {
        throw new AggregationException(`Maximum ${maxGroupByFields} GROUP BY fields allowed`);
      }
      if (config.groupByFields && config.groupByFields.length > 0) {
        for (const gb of parsed) {
          if (!config.groupByFields.includes(gb)) {
            throw new AggregationException(`Field '${gb}' is not allowed for GROUP BY`);
          }
        }
      }
      groupBy = parsed;
    }
  }

  const spec: AggregateSpec = { operation, filters };
  if (field !== undefined) spec.field = field;
  if (groupBy !== undefined) spec.groupBy = groupBy;
  return spec;
}

// ---------------------------------------------------------------------------
// In-memory compute
// ---------------------------------------------------------------------------

function numericValues(rows: Array<Record<string, unknown>>, field: string): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const v = row[field];
    if (typeof v === 'number') out.push(v);
  }
  return out;
}

/** Compute a single operation over a row set (empty ⇒ 0 for count, else null). */
function computeOne(
  rows: Array<Record<string, unknown>>,
  operation: AggregateOperation,
  field: string | undefined,
): number | null {
  if (rows.length === 0) {
    return operation === 'count' ? 0 : null;
  }

  switch (operation) {
    case 'count':
      if (!field) return rows.length;
      return rows.filter((r) => r[field] !== null && r[field] !== undefined).length;
    case 'countDistinct': {
      if (!field) return null;
      const unique = new Set(
        rows
          .map((r) => r[field])
          .filter((v) => v !== null && v !== undefined)
          .map((v) => String(v)),
      );
      return unique.size;
    }
    case 'sum': {
      if (!field) return null;
      let sum = 0;
      for (const v of numericValues(rows, field)) sum += v;
      return sum;
    }
    case 'avg': {
      if (!field) return null;
      const values = numericValues(rows, field);
      if (values.length === 0) return null;
      return values.reduce((a, b) => a + b, 0) / values.length;
    }
    case 'min': {
      if (!field) return null;
      const values = numericValues(rows, field);
      return values.length === 0 ? null : Math.min(...values);
    }
    case 'max': {
      if (!field) return null;
      const values = numericValues(rows, field);
      return values.length === 0 ? null : Math.max(...values);
    }
  }
}

/**
 * In-memory aggregate fallback for adapters without native aggregation.
 * Applies `spec.filters` (WHERE) first, then computes the single operation.
 *
 * The result is `{ buckets }`: one bucket without `groupBy`, or one bucket per
 * group. Each bucket holds the (null-coerced) group-key columns plus the
 * aggregate value keyed by the operation name (e.g. `{ category: 'A', sum: 30 }`).
 */
export function computeAggregateFallback<T extends Record<string, unknown>>(
  rows: T[],
  spec: AggregateSpec,
): AggregateResult {
  const filtered = applyFilters(rows, spec.filters);
  const valueKey = spec.operation;

  if (!spec.groupBy || spec.groupBy.length === 0) {
    return { buckets: [{ [valueKey]: computeOne(filtered, spec.operation, spec.field) }] };
  }

  const groupBy = spec.groupBy;
  const groups = new Map<string, T[]>();
  for (const row of filtered) {
    const key = groupBy.map((f) => String(row[f] ?? 'null')).join('|');
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const buckets: Array<Record<string, unknown>> = [];
  for (const [keyStr, groupRows] of groups) {
    const parts = keyStr.split('|');
    const bucket: Record<string, unknown> = {};
    groupBy.forEach((f, i) => {
      bucket[f] = parts[i] === 'null' ? null : parts[i];
    });
    bucket[valueKey] = computeOne(groupRows, spec.operation, spec.field);
    buckets.push(bucket);
  }

  return { buckets };
}
