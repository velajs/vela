import { describe, expect, it } from 'vitest';
import type { AggregateSpec, FilterCondition } from '../../adapter/query-types';
import { AggregationException } from '../../envelope/errors';
import { buildAggregateSpec, computeAggregateFallback } from '../aggregate';

const records = [
  { category: 'A', value: 10, tag: 'x' },
  { category: 'A', value: 20, tag: 'y' },
  { category: 'B', value: 30, tag: 'x' },
  { category: 'B', value: 40, tag: 'x' },
  { category: 'B', value: 50, tag: 'z' },
];

describe('buildAggregateSpec', () => {
  it('throws when the operation is missing', () => {
    expect(() => buildAggregateSpec({})).toThrow(AggregationException);
  });

  it('throws on an unknown operation', () => {
    expect(() => buildAggregateSpec({ operation: 'median', field: 'value' })).toThrow(AggregationException);
  });

  it('builds count(*) without a field', () => {
    expect(buildAggregateSpec({ operation: 'count' })).toEqual({ operation: 'count', filters: [] });
    // `*` is normalized away for count.
    expect(buildAggregateSpec({ operation: 'count', field: '*' })).toEqual({
      operation: 'count',
      filters: [],
    });
  });

  it('normalizes countdistinct case-insensitively', () => {
    const spec = buildAggregateSpec({ operation: 'countdistinct', field: 'tag' });
    expect(spec.operation).toBe('countDistinct');
    expect(spec.field).toBe('tag');
  });

  it('requires a field for non-count operations', () => {
    expect(() => buildAggregateSpec({ operation: 'sum' })).toThrow(/Field is required/);
    expect(() => buildAggregateSpec({ operation: 'avg' })).toThrow(AggregationException);
  });

  it('enforces the per-operation field allow-list', () => {
    expect(() => buildAggregateSpec({ operation: 'sum', field: 'other' }, { sumFields: ['value'] })).toThrow(
      /not allowed for SUM/,
    );
    expect(buildAggregateSpec({ operation: 'sum', field: 'value' }, { sumFields: ['value'] })).toMatchObject({
      operation: 'sum',
      field: 'value',
    });
  });

  it('validates groupBy against the allow-list and cardinality cap', () => {
    expect(() =>
      buildAggregateSpec({ operation: 'count', groupBy: 'evil' }, { groupByFields: ['category'] }),
    ).toThrow(/not allowed for GROUP BY/);
    expect(() =>
      buildAggregateSpec({ operation: 'count', groupBy: 'a,b,c' }, { maxGroupByFields: 2 }),
    ).toThrow(/Maximum 2 GROUP BY/);
  });

  it('parses a full spec with groupBy split on commas', () => {
    const filters: FilterCondition[] = [{ field: 'category', operator: 'eq', value: 'A' }];
    const spec = buildAggregateSpec(
      { operation: 'sum', field: 'value', groupBy: 'category, tag' },
      { sumFields: ['value'], groupByFields: ['category', 'tag'] },
      filters,
    );
    expect(spec).toEqual({
      operation: 'sum',
      field: 'value',
      groupBy: ['category', 'tag'],
      filters,
    });
  });
});

describe('computeAggregateFallback', () => {
  const spec = (over: Partial<AggregateSpec>): AggregateSpec => ({
    operation: 'count',
    filters: [],
    ...over,
  });

  it('computes COUNT(*)', () => {
    expect(computeAggregateFallback(records, spec({ operation: 'count' }))).toEqual({
      buckets: [{ count: 5 }],
    });
  });

  it('computes SUM / AVG / MIN / MAX', () => {
    expect(computeAggregateFallback(records, spec({ operation: 'sum', field: 'value' }))).toEqual({
      buckets: [{ sum: 150 }],
    });
    expect(computeAggregateFallback(records, spec({ operation: 'avg', field: 'value' }))).toEqual({
      buckets: [{ avg: 30 }],
    });
    expect(computeAggregateFallback(records, spec({ operation: 'min', field: 'value' }))).toEqual({
      buckets: [{ min: 10 }],
    });
    expect(computeAggregateFallback(records, spec({ operation: 'max', field: 'value' }))).toEqual({
      buckets: [{ max: 50 }],
    });
  });

  it('computes COUNT DISTINCT', () => {
    expect(computeAggregateFallback(records, spec({ operation: 'countDistinct', field: 'tag' }))).toEqual({
      buckets: [{ countDistinct: 3 }],
    });
  });

  it('groups by a field', () => {
    const result = computeAggregateFallback(records, spec({ operation: 'sum', field: 'value', groupBy: ['category'] }));
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets).toContainEqual({ category: 'A', sum: 30 });
    expect(result.buckets).toContainEqual({ category: 'B', sum: 120 });
  });

  it('applies WHERE filters before aggregating', () => {
    const result = computeAggregateFallback(
      records,
      spec({ operation: 'count', filters: [{ field: 'category', operator: 'eq', value: 'B' }] }),
    );
    expect(result).toEqual({ buckets: [{ count: 3 }] });
  });

  it('returns 0 for count and null for others over an empty set', () => {
    expect(computeAggregateFallback([], spec({ operation: 'count' }))).toEqual({ buckets: [{ count: 0 }] });
    expect(computeAggregateFallback([], spec({ operation: 'sum', field: 'value' }))).toEqual({
      buckets: [{ sum: null }],
    });
  });
});
