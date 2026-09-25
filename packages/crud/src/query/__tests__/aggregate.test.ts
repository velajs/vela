import { describe, expect, it } from 'vitest';
import type { AggregateSpec } from '../../adapter/query-types';
import { AggregationException } from '../../envelope/errors';
import { buildAggregateSpec, computeAggregateFallback, getAggregateAlias } from '../aggregate';
import type { AggregateBuildConfig } from '../aggregate';

const ALLOWED_FIELDS: AggregateBuildConfig = {
  countFields: ['id'],
  sumFields: ['amount', 'price', 'quantity', 'value'],
  avgFields: ['age', 'value'],
  minMaxFields: ['price', 'value'],
  countDistinctFields: ['tag'],
  groupByFields: ['category', 'tag', 'a', 'b', 'c'],
};

const build = (
  query: Parameters<typeof buildAggregateSpec>[0],
  config: AggregateBuildConfig = {},
  filters: Parameters<typeof buildAggregateSpec>[2] = [],
) => buildAggregateSpec(query, { ...ALLOWED_FIELDS, ...config }, filters);

const records = [
  { category: 'A', value: 10, tag: 'x' },
  { category: 'A', value: 20, tag: 'y' },
  { category: 'B', value: 30, tag: 'x' },
  { category: 'B', value: 40, tag: 'x' },
  { category: 'B', value: 50, tag: 'z' },
];

describe('getAggregateAlias', () => {
  it('is the bare operation for COUNT(*), else camelCase op+Field', () => {
    expect(getAggregateAlias({ operation: 'count', field: '*' })).toBe('count');
    expect(getAggregateAlias({ operation: 'count', field: 'id' })).toBe('countId');
    expect(getAggregateAlias({ operation: 'sum', field: 'amount' })).toBe('sumAmount');
    expect(getAggregateAlias({ operation: 'avg', field: 'age' })).toBe('avgAge');
    expect(getAggregateAlias({ operation: 'countDistinct', field: 'tag' })).toBe(
      'countDistinctTag',
    );
  });

  it('honors an explicit alias', () => {
    expect(getAggregateAlias({ operation: 'sum', field: 'amount', alias: 'total' })).toBe('total');
  });
});

describe('buildAggregateSpec', () => {
  it('defaults to COUNT(*) when nothing is requested', () => {
    expect(build({})).toEqual({
      aggregations: [{ operation: 'count', field: '*' }],
      filters: [],
    });
    // `count=*`, `count=true`, and `count=''` (falsy → skipped → default) all
    // collapse to COUNT(*).
    expect(build({ count: '*' }).aggregations).toEqual([{ operation: 'count', field: '*' }]);
    expect(build({ count: 'true' }).aggregations).toEqual([{ operation: 'count', field: '*' }]);
    expect(build({ count: '' }).aggregations).toEqual([{ operation: 'count', field: '*' }]);
  });

  it('parses multiple operations in AGGREGATE_OPERATIONS order', () => {
    const spec = build({ sum: 'amount', avg: 'age', count: '*' });
    expect(spec.aggregations).toEqual([
      { operation: 'count', field: '*' },
      { operation: 'sum', field: 'amount' },
      { operation: 'avg', field: 'age' },
    ]);
  });

  it('accepts the same operation on multiple fields (repeated param)', () => {
    const spec = build({ min: 'price', max: 'price' });
    expect(spec.aggregations).toEqual([
      { operation: 'min', field: 'price' },
      { operation: 'max', field: 'price' },
    ]);
    const summed = build({ sum: ['price', 'quantity'] });
    expect(summed.aggregations).toEqual([
      { operation: 'sum', field: 'price' },
      { operation: 'sum', field: 'quantity' },
    ]);
  });

  it('enforces the per-operation field allow-list', () => {
    expect(() => buildAggregateSpec({ sum: 'other' }, { sumFields: ['value'] })).toThrow(
      /not allowed for SUM/,
    );
    expect(buildAggregateSpec({ sum: 'value' }, { sumFields: ['value'] }).aggregations).toEqual([
      { operation: 'sum', field: 'value' },
    ]);
    expect(() => buildAggregateSpec({ count: 'id' }, {})).toThrow(/not allowed for COUNT/);
    expect(buildAggregateSpec({ count: 'id' }, { countFields: ['id'] }).aggregations).toEqual([
      { operation: 'count', field: 'id' },
    ]);
  });

  it('validates groupBy against the allow-list and cardinality cap', () => {
    expect(() =>
      buildAggregateSpec({ count: '*', groupBy: 'evil' }, { groupByFields: ['category'] }),
    ).toThrow(/not allowed for GROUP BY/);
    expect(() => build({ count: '*', groupBy: 'a,b,c' }, { maxGroupByFields: 2 })).toThrow(
      /Maximum 2 GROUP BY/,
    );
    expect(build({ count: '*', groupBy: 'category, tag' }).groupBy).toEqual(['category', 'tag']);
  });

  it('parses having[alias][op]=value', () => {
    const spec = build({
      count: '*',
      groupBy: 'category',
      'having[count][gte]': '2',
      'having[count][lt]': '10',
    });
    expect(spec.having).toEqual({ count: { gte: '2', lt: '10' } });
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects prototype-pollution key %s in aliases and operators',
    (unsafeKey) => {
      const prototype = Object.prototype as Record<string, unknown>;
      delete prototype.withDeleted;
      for (const expression of [`having[${unsafeKey}][gte]`, `having[count][${unsafeKey}]`]) {
        expect(() =>
          build({
            count: '*',
            groupBy: 'category',
            [expression]: 'true',
          }),
        ).toThrow(AggregationException);
      }
      expect(prototype.withDeleted).toBeUndefined();
    },
  );

  it('parses orderBy/orderDirection (default asc, only with orderBy)', () => {
    const desc = build({
      sum: 'value',
      groupBy: 'category',
      orderBy: 'sumValue',
      orderDirection: 'desc',
    });
    expect(desc.orderBy).toBe('sumValue');
    expect(desc.orderDirection).toBe('desc');
    const asc = build({ count: '*', groupBy: 'category', orderBy: 'category' });
    expect(asc.orderDirection).toBe('asc');
    // No orderDirection without an orderBy.
    expect(build({ count: '*' }).orderDirection).toBeUndefined();
  });

  it('parses group limit/offset and injects the default limit for grouped queries', () => {
    const paged = build({ count: '*', groupBy: 'category', limit: '5', offset: '2' });
    expect(paged.limit).toBe(5);
    expect(paged.offset).toBe(2);
    // Grouped, no explicit limit → default 100 (overridable).
    expect(build({ count: '*', groupBy: 'category' }).limit).toBe(100);
    expect(build({ count: '*', groupBy: 'category' }, { defaultLimit: 25 }).limit).toBe(25);
    // Ungrouped queries get no default limit.
    expect(build({ count: '*' }).limit).toBeUndefined();
  });

  it('rejects a limit above the ceiling', () => {
    expect(() => build({ count: '*', limit: '2000' })).toThrow(/Limit cannot exceed 1000/);
    expect(() => build({ count: '*', limit: '50' }, { maxLimit: 40 })).toThrow(
      /Limit cannot exceed 40/,
    );
  });

  it('rejects negative pagination', () => {
    expect(() => build({ count: '*', limit: '-1' })).toThrow(/negative/);
    expect(() => build({ count: '*', offset: '-1' })).toThrow(/negative/);
  });

  it('threads the already-parsed filters through', () => {
    const filters = [{ field: 'category', operator: 'eq' as const, value: 'A' }];
    expect(build({ count: '*' }, {}, filters).filters).toBe(filters);
  });
});

describe('computeAggregateFallback', () => {
  const spec = (over: Partial<AggregateSpec>): AggregateSpec => ({
    aggregations: [{ operation: 'count', field: '*' }],
    filters: [],
    ...over,
  });

  it('computes ungrouped values keyed by alias', () => {
    expect(computeAggregateFallback(records, spec({}))).toEqual({ values: { count: 5 } });
    expect(
      computeAggregateFallback(
        records,
        spec({ aggregations: [{ operation: 'sum', field: 'value' }] }),
      ),
    ).toEqual({ values: { sumValue: 150 } });
    expect(
      computeAggregateFallback(
        records,
        spec({ aggregations: [{ operation: 'avg', field: 'value' }] }),
      ),
    ).toEqual({ values: { avgValue: 30 } });
    expect(
      computeAggregateFallback(
        records,
        spec({ aggregations: [{ operation: 'min', field: 'value' }] }),
      ),
    ).toEqual({ values: { minValue: 10 } });
    expect(
      computeAggregateFallback(
        records,
        spec({ aggregations: [{ operation: 'max', field: 'value' }] }),
      ),
    ).toEqual({ values: { maxValue: 50 } });
    expect(
      computeAggregateFallback(
        records,
        spec({ aggregations: [{ operation: 'countDistinct', field: 'tag' }] }),
      ),
    ).toEqual({ values: { countDistinctTag: 3 } });
  });

  it('computes several aggregations in one pass', () => {
    const result = computeAggregateFallback(
      records,
      spec({
        aggregations: [
          { operation: 'count', field: '*' },
          { operation: 'sum', field: 'value' },
          { operation: 'avg', field: 'value' },
        ],
      }),
    );
    expect(result).toEqual({ values: { count: 5, sumValue: 150, avgValue: 30 } });
  });

  it('groups by a field into { groups, totalGroups }', () => {
    const result = computeAggregateFallback(
      records,
      spec({ aggregations: [{ operation: 'sum', field: 'value' }], groupBy: ['category'] }),
    );
    expect(result.totalGroups).toBe(2);
    expect(result.groups).toContainEqual({ key: { category: 'A' }, values: { sumValue: 30 } });
    expect(result.groups).toContainEqual({ key: { category: 'B' }, values: { sumValue: 120 } });
    expect(result.values).toBeUndefined();
  });

  it('applies HAVING on the aggregate alias (totalGroups reflects post-HAVING)', () => {
    const result = computeAggregateFallback(
      records,
      spec({
        aggregations: [{ operation: 'count', field: '*' }],
        groupBy: ['category'],
        having: { count: { gte: '3' } },
      }),
    );
    expect(result.totalGroups).toBe(1);
    expect(result.groups).toEqual([{ key: { category: 'B' }, values: { count: 3 } }]);
  });

  it('orders groups by an aggregate alias', () => {
    const result = computeAggregateFallback(
      records,
      spec({
        aggregations: [{ operation: 'sum', field: 'value' }],
        groupBy: ['category'],
        orderBy: 'sumValue',
        orderDirection: 'desc',
      }),
    );
    expect(result.groups?.map((g) => g.key.category)).toEqual(['B', 'A']);
  });

  it('paginates groups with limit/offset (totalGroups is the full count)', () => {
    const result = computeAggregateFallback(
      records,
      spec({
        aggregations: [{ operation: 'sum', field: 'value' }],
        groupBy: ['category'],
        orderBy: 'sumValue',
        orderDirection: 'desc',
        limit: 1,
      }),
    );
    expect(result.totalGroups).toBe(2);
    expect(result.groups).toEqual([{ key: { category: 'B' }, values: { sumValue: 120 } }]);
  });

  it('returns 0 for count and null for others over an empty set', () => {
    expect(computeAggregateFallback([], spec({}))).toEqual({ values: { count: 0 } });
    expect(
      computeAggregateFallback([], spec({ aggregations: [{ operation: 'sum', field: 'value' }] })),
    ).toEqual({ values: { sumValue: null } });
    expect(
      computeAggregateFallback(
        [],
        spec({ aggregations: [{ operation: 'count', field: '*' }], groupBy: ['category'] }),
      ),
    ).toEqual({ groups: [], totalGroups: 0 });
  });

  it('re-emits group-key columns as strings, decoding the literal null', () => {
    const rows = [
      { category: null, value: 1 },
      { category: 'A', value: 2 },
    ];
    const result = computeAggregateFallback(
      rows,
      spec({ aggregations: [{ operation: 'count', field: '*' }], groupBy: ['category'] }),
    );
    expect(result.groups).toContainEqual({ key: { category: null }, values: { count: 1 } });
    expect(result.groups).toContainEqual({ key: { category: 'A' }, values: { count: 1 } });
  });
});
