import { describe, expect, it } from 'vitest';

import { FILTER_OPERATORS } from '../../adapter/query-types';
import { AggregationException } from '../../envelope/errors';
import { buildAggregateSpec, type AggregateBuildConfig } from '../aggregate';
import { parseFilterValue, parseListFilters, type RawQuery } from '../filters';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[next() % values.length]!;
}

function randomText(next: () => number, alphabet: string, maxLength: number): string {
  const length = next() % (maxLength + 1);
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[next() % alphabet.length];
  }
  return value;
}

describe('security property sweep — CRUD query parsing', () => {
  const config = {
    filterFields: ['role'],
    filterConfig: {
      age: ['gte', 'lte', 'between'],
      tags: ['in'],
      deleted: ['null'],
    } as const,
    sortFields: ['role', 'age'],
    allowedIncludes: ['profile', 'posts'],
    fieldSelectionEnabled: true,
    allowedSelectFields: ['id', 'role', 'age'],
    blockedSelectFields: ['secret'],
    maxPerPage: 50,
  };

  it('drops hostile fields, operators, and nested bracket shapes without widening the query', () => {
    const next = seeded(0xc2d0_2026);
    const hostileKeys = [
      '__proto__',
      'constructor',
      'prototype',
      '__proto__[eq]',
      'constructor[eq]',
      'prototype[eq]',
      'role[constructor]',
      'role[__proto__]',
      'age',
      'age[eq]',
      'tags',
      'deleted',
      'age[wat]',
      'age[gte][extra]',
      'user[role][eq]',
      'having[x][eq]',
      '[[[[age]]]]',
      'secret',
      'secret[eq]',
    ] as const;
    const ordinaryKeys = [
      'role',
      'age[gte]',
      'age[lte]',
      'age[between]',
      'tags[in]',
      'deleted[null]',
      'page',
      'per_page',
      'sort',
      'order',
      'include',
      'fields',
    ] as const;
    const permittedFields = new Set(['role', 'age', 'tags', 'deleted']);
    const permittedOperators = new Map<string, ReadonlySet<string>>([
      ['role', new Set(['eq'])],
      ['age', new Set(['gte', 'lte', 'between'])],
      ['tags', new Set(['in'])],
      ['deleted', new Set(['null'])],
    ]);

    for (let sample = 0; sample < 500; sample += 1) {
      const query = Object.create(null) as RawQuery;
      const entries = 2 + (next() % 12);
      query[pick(next, hostileKeys)] = randomText(next, 'abcXYZ012[]_,.-', 48);
      for (let index = 1; index < entries; index += 1) {
        const key = next() % 3 === 0 ? pick(next, ordinaryKeys) : pick(next, hostileKeys);
        query[key] = randomText(next, 'abcXYZ012[]_,.-', 48);
      }

      const parsed = parseListFilters(query, config);
      for (const filter of parsed.filters) {
        expect(permittedFields.has(filter.field)).toBe(true);
        expect(permittedOperators.get(filter.field)?.has(filter.operator)).toBe(true);
      }
      expect(parsed.options.per_page).toBeGreaterThanOrEqual(1);
      expect(parsed.options.per_page).toBeLessThanOrEqual(50);
      expect(
        parsed.options.include?.every((field) => ['profile', 'posts'].includes(field)),
      ).not.toBe(false);
      expect(
        parsed.options.fields?.every((field) => ['id', 'role', 'age'].includes(field)),
      ).not.toBe(false);
      expect(Object.prototype).not.toHaveProperty('polluted');
    }
  });

  it('never promotes a randomized bracket token into an unknown operator', () => {
    const next = seeded(0x0f17_e2a7);
    const supported = new Set<string>(FILTER_OPERATORS);

    for (let sample = 0; sample < 500; sample += 1) {
      const operator = randomText(
        next,
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_',
        24,
      );
      const raw = `[${operator}]${randomText(next, 'abc012,[]', 48)}`;
      const parsed = parseFilterValue(raw);
      expect(supported.has(parsed.operator)).toBe(true);
      if (!supported.has(operator)) {
        expect(parsed).toEqual({ operator: 'eq', value: raw });
      }
    }
  });
});

describe('security property sweep — aggregate query parsing', () => {
  const config: AggregateBuildConfig = { sumFields: ['amount'], maxLimit: 100 };

  it('rejects randomized unsafe HAVING aliases and operators', () => {
    const next = seeded(0xa66e_6a7e);
    const unsafeAliases = ['__proto__', 'prototype', 'constructor'] as const;
    const unsafeOperators = [
      '__proto__',
      'prototype',
      'constructor',
      'valueOf',
      'toString',
    ] as const;

    for (let sample = 0; sample < 300; sample += 1) {
      const query = Object.create(null) as RawQuery;
      query.sum = 'amount';
      const key =
        sample % 2 === 0
          ? `having[${pick(next, unsafeAliases)}][eq]`
          : `having[sumAmount][${pick(next, unsafeOperators)}]`;
      query[key] = String(next() % 100);

      expect(() => buildAggregateSpec(query, config)).toThrow(AggregationException);
      expect(Object.prototype).not.toHaveProperty('polluted');
    }
  });

  it('ignores depth-shaped expressions that do not match the exact HAVING grammar', () => {
    const next = seeded(0xde07_4a11);

    for (let sample = 0; sample < 300; sample += 1) {
      const query = Object.create(null) as RawQuery;
      query.sum = 'amount';
      const depth = 2 + (next() % 20);
      query[`having[sumAmount][eq]${'[nested]'.repeat(depth)}`] = String(next() % 100);

      const spec = buildAggregateSpec(query, config);
      expect(spec.having).toBeUndefined();
      expect(Object.getPrototypeOf(query)).toBeNull();
      expect(Object.prototype).not.toHaveProperty('polluted');
    }
  });
});
