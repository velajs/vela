import { describe, expect, it } from 'vitest';
import {
  FILTER_OPERATORS,
  assertNever,
  isFilterOperator,
  type FilterCondition,
} from '../../adapter/query-types';
import {
  applyFilters,
  matchesFilter,
  normalizeNeedle,
  parseFilterValue,
  parseListFilters,
} from '../filters';

describe('FilterOperator single source of truth', () => {
  it('lists every supported operator', () => {
    expect([...FILTER_OPERATORS]).toEqual([
      'eq',
      'ne',
      'gt',
      'gte',
      'lt',
      'lte',
      'in',
      'nin',
      'like',
      'ilike',
      'null',
      'between',
    ]);
  });

  it('isFilterOperator accepts known operators and rejects unknown tokens', () => {
    for (const op of FILTER_OPERATORS) expect(isFilterOperator(op)).toBe(true);
    expect(isFilterOperator('foo')).toBe(false);
    expect(isFilterOperator('')).toBe(false);
    expect(isFilterOperator('EQ')).toBe(false);
  });

  it('assertNever throws on an invariant violation', () => {
    expect(() => assertNever('unexpected' as never)).toThrow(
      /Unhandled discriminated union member/,
    );
  });
});

describe('parseFilterValue', () => {
  it('parses a recognized operator from the bracket syntax', () => {
    expect(parseFilterValue('[gte]30')).toEqual({ operator: 'gte', value: '30' });
  });

  it('splits array operators into trimmed parts', () => {
    expect(parseFilterValue('[in]1, 2 ,3')).toEqual({ operator: 'in', value: ['1', '2', '3'] });
  });

  it('coerces the null operator to a boolean', () => {
    expect(parseFilterValue('[null]true')).toEqual({ operator: 'null', value: true });
    expect(parseFilterValue('[null]false')).toEqual({ operator: 'null', value: false });
  });

  it('neutralizes an unknown operator instead of forging an invalid one (fail-closed)', () => {
    expect(parseFilterValue('[foo]30')).toEqual({ operator: 'eq', value: '[foo]30' });
  });

  it('treats a plain value as equality', () => {
    expect(parseFilterValue('hello')).toEqual({ operator: 'eq', value: 'hello' });
  });
});

describe('normalizeNeedle (literal-needle like/ilike contract)', () => {
  it('strips % wildcards', () => {
    expect(normalizeNeedle('50%')).toBe('50');
    expect(normalizeNeedle('a%b%c')).toBe('abc');
    expect(normalizeNeedle('%%')).toBe('');
  });

  it('keeps _ inert (literal underscore, not a wildcard)', () => {
    expect(normalizeNeedle('foo_bar')).toBe('foo_bar');
  });
});

describe('matchesFilter', () => {
  it('handles each operator', () => {
    expect(matchesFilter('a', { field: 'x', operator: 'eq', value: 'a' })).toBe(true);
    expect(matchesFilter('a', { field: 'x', operator: 'ne', value: 'b' })).toBe(true);
    expect(matchesFilter(5, { field: 'x', operator: 'gt', value: 3 })).toBe(true);
    expect(matchesFilter(5, { field: 'x', operator: 'gte', value: 5 })).toBe(true);
    expect(matchesFilter(2, { field: 'x', operator: 'lt', value: 3 })).toBe(true);
    expect(matchesFilter(3, { field: 'x', operator: 'lte', value: 3 })).toBe(true);
    expect(matchesFilter('a', { field: 'x', operator: 'in', value: ['a', 'b'] })).toBe(true);
    expect(matchesFilter('c', { field: 'x', operator: 'nin', value: ['a', 'b'] })).toBe(true);
    expect(matchesFilter(5, { field: 'x', operator: 'between', value: ['1', '10'] })).toBe(true);
    expect(matchesFilter(null, { field: 'x', operator: 'null', value: true })).toBe(true);
    expect(matchesFilter('v', { field: 'x', operator: 'null', value: false })).toBe(true);
  });

  it('applies the literal-needle contract for like/ilike', () => {
    // `%` in the needle is stripped, so "50%" matches a value containing "50".
    expect(matchesFilter('50 percent off', { field: 'x', operator: 'like', value: '50%' })).toBe(
      true,
    );
    // `_` is literal: "foo_bar" needle must NOT match "fooXbar".
    expect(matchesFilter('fooXbar', { field: 'x', operator: 'like', value: 'foo_bar' })).toBe(
      false,
    );
    expect(
      matchesFilter('Literal foo_bar', { field: 'x', operator: 'like', value: 'foo_bar' }),
    ).toBe(true);
    // like is case-sensitive; ilike is not.
    expect(matchesFilter('HELLO', { field: 'x', operator: 'like', value: 'hello' })).toBe(false);
    expect(matchesFilter('HELLO', { field: 'x', operator: 'ilike', value: 'hello' })).toBe(true);
  });

  it('fails closed on an operator outside the closed union', () => {
    const forged = { field: 'x', operator: 'bogus', value: 1 } as unknown as FilterCondition;
    expect(matchesFilter(1, forged)).toBe(false);
  });
});

describe('applyFilters', () => {
  const rows = [
    { id: '1', role: 'admin', age: 30 },
    { id: '2', role: 'user', age: 20 },
    { id: '3', role: 'user', age: 40 },
  ];

  it('keeps rows matching every condition', () => {
    const out = applyFilters(rows, [
      { field: 'role', operator: 'eq', value: 'user' },
      { field: 'age', operator: 'gte', value: '30' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['3']);
  });

  it('returns all rows for an empty condition set', () => {
    expect(applyFilters(rows, [])).toBe(rows);
  });
});

describe('parseListFilters', () => {
  const config = {
    filterFields: ['role'],
    filterConfig: { age: ['gte', 'lte', 'between'], tags: ['in'], deleted: ['null'] } as const,
  };

  it('treats a bare field=value as equality (allow-listed)', () => {
    const { filters } = parseListFilters({ role: 'admin' }, config);
    expect(filters).toEqual([{ field: 'role', operator: 'eq', value: 'admin' }]);
  });

  it('requires equality to be allowed for both bare and bracket filters', () => {
    for (const query of [{ age: '5' }, { 'age[eq]': '5' }]) {
      expect(parseListFilters(query, config).filters).toEqual([]);
    }

    const equalityConfig = { filterConfig: { age: ['eq'] } } as const;
    for (const query of [{ age: '5' }, { 'age[eq]': '5' }]) {
      expect(parseListFilters(query, equalityConfig).filters).toEqual([
        { field: 'age', operator: 'eq', value: '5' },
      ]);
    }
  });

  it('lets filterConfig disable equality granted by filterFields', () => {
    const narrowedConfig = { filterFields: ['age'], filterConfig: { age: ['gte'] } as const };
    expect(parseListFilters({ age: '5' }, narrowedConfig).filters).toEqual([]);
    expect(parseListFilters({ 'age[gte]': '5' }, narrowedConfig).filters).toEqual([
      { field: 'age', operator: 'gte', value: '5' },
    ]);
  });

  it('disables both equality syntaxes with an empty operator allow-list', () => {
    const disabledConfig = { filterFields: ['age'], filterConfig: { age: [] } };
    for (const query of [{ age: '5' }, { 'age[eq]': '5' }]) {
      expect(parseListFilters(query, disabledConfig).filters).toEqual([]);
    }
  });

  it('parses bracket operator syntax', () => {
    const { filters } = parseListFilters({ 'age[gte]': '18' }, config);
    expect(filters).toEqual([{ field: 'age', operator: 'gte', value: '18' }]);
  });

  it('splits in/nin/between on commas (trimmed)', () => {
    const inResult = parseListFilters({ 'tags[in]': 'a, b ,c' }, config);
    expect(inResult.filters).toEqual([{ field: 'tags', operator: 'in', value: ['a', 'b', 'c'] }]);

    const betweenResult = parseListFilters({ 'age[between]': '10,20' }, config);
    expect(betweenResult.filters).toEqual([
      { field: 'age', operator: 'between', value: ['10', '20'] },
    ]);
  });

  it('coerces the null operator to a boolean', () => {
    const { filters } = parseListFilters({ 'deleted[null]': 'true' }, config);
    expect(filters).toEqual([{ field: 'deleted', operator: 'null', value: true }]);
  });

  it('fails closed on an unknown operator for an allowed field (silently drops)', () => {
    const { filters } = parseListFilters({ 'age[wat]': '5' }, config);
    expect(filters).toEqual([]);
  });

  it('fails closed on an operator not allow-listed for that field (silently drops)', () => {
    // `age` allows gte/lte/between but not eq.
    const { filters } = parseListFilters({ 'age[eq]': '5' }, config);
    expect(filters).toEqual([]);
  });

  it('fails closed on an unallowed field (silently drops)', () => {
    const bare = parseListFilters({ secret: 'x' }, config);
    expect(bare.filters).toEqual([]);
    const bracket = parseListFilters({ 'secret[eq]': 'x' }, config);
    expect(bracket.filters).toEqual([]);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects prototype key %s without throwing or inheriting an allow-list',
    (field) => {
      expect(parseListFilters({ [field]: 'x', [`${field}[eq]`]: 'x' }, config).filters).toEqual([]);
      expect(
        parseListFilters(
          { [field]: 'x', [`${field}[eq]`]: 'x' },
          {
            filterFields: [field],
            filterConfig: { [field]: ['eq'] },
          },
        ).filters,
      ).toEqual([]);
    },
  );

  it('routes reserved params to options, never to filters', () => {
    const { filters, options } = parseListFilters(
      {
        role: 'admin',
        page: '2',
        per_page: '5',
        sort: 'role',
        order: 'desc',
        include: 'posts,profile',
        onlyDeleted: 'true',
        withDeleted: 'true',
      },
      { ...config, sortFields: ['role'], allowedIncludes: ['posts', 'profile'] },
    );
    expect(filters).toEqual([{ field: 'role', operator: 'eq', value: 'admin' }]);
    expect(options.page).toBe(2);
    expect(options.per_page).toBe(5);
    expect(options.order_by).toBe('role');
    expect(options.order_by_direction).toBe('desc');
    expect(options.include).toEqual(['posts', 'profile']);
    expect(options.onlyDeleted).toBe(true);
    expect(options.withDeleted).toBe(true);
  });

  it('clamps per_page to [1, maxPerPage] and defaults page/per_page', () => {
    const clampHigh = parseListFilters({ per_page: '9999' }, config);
    expect(clampHigh.options.per_page).toBe(100);

    const clampLow = parseListFilters({ per_page: '0' }, config);
    expect(clampLow.options.per_page).toBe(20); // parseInt('0')||default -> 20

    const defaults = parseListFilters({}, config);
    expect(defaults.options.page).toBe(1);
    expect(defaults.options.per_page).toBe(20);
    expect(defaults.options.order_by_direction).toBe('asc');
  });

  it('forces cursor-field ascending ordering during a cursor walk', () => {
    const { options } = parseListFilters(
      { cursor: 'abc', limit: '5', sort: 'role', order: 'desc' },
      { ...config, cursorPaginationEnabled: true, cursorField: 'id', sortFields: ['role'] },
    );
    expect(options.cursor).toBe('abc');
    expect(options.limit).toBe(5);
    expect(options.order_by).toBe('id');
    expect(options.order_by_direction).toBe('asc');
  });
});
