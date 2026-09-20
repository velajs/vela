import { encodeKeyset, resolveKeyset, isAfterKeyset } from '../pagination';
import { describe, expect, it } from 'vitest';
import { InputValidationException } from '../../envelope/errors';
import {
  buildCursorPageInfo,
  buildOffsetPageInfo,
  decodeCursor,
  encodeCursor,
  resolveCursor,
  resolveOffsetPagination,
} from '../pagination';

describe('resolveOffsetPagination', () => {
  it('defaults page to 1 and per_page to 20', () => {
    expect(resolveOffsetPagination({})).toEqual({ page: 1, perPage: 20 });
  });

  it('clamps per_page to the [1, 100] range', () => {
    expect(resolveOffsetPagination({ per_page: '9999' }).perPage).toBe(100);
    expect(resolveOffsetPagination({ per_page: '50' }).perPage).toBe(50);
    // parseInt('0') || default -> 20
    expect(resolveOffsetPagination({ per_page: '0' }).perPage).toBe(20);
  });

  it('forces page to at least 1', () => {
    expect(resolveOffsetPagination({ page: '-3' }).page).toBe(1);
    expect(resolveOffsetPagination({ page: '4' }).page).toBe(4);
  });

  it('honors custom defaults/max', () => {
    expect(resolveOffsetPagination({ per_page: '40' }, { maxPerPage: 25 }).perPage).toBe(25);
    expect(resolveOffsetPagination({}, { defaultPerPage: 10 }).perPage).toBe(10);
  });
});

describe('buildOffsetPageInfo', () => {
  it('computes the canonical 6-field offset envelope', () => {
    expect(buildOffsetPageInfo(2, 10, 25)).toEqual({
      page: 2,
      per_page: 10,
      total_count: 25,
      total_pages: 3,
      has_next_page: true,
      has_prev_page: true,
    });
  });

  it('sets has_next_page false on the last page and has_prev_page false on page one', () => {
    expect(buildOffsetPageInfo(1, 10, 5)).toMatchObject({
      has_next_page: false,
      has_prev_page: false,
    });
    expect(buildOffsetPageInfo(3, 10, 25)).toMatchObject({
      has_next_page: false,
      has_prev_page: true,
    });
  });
});

describe('cursor codec', () => {
  it('round-trips a value through opaque base64', () => {
    const encoded = encodeCursor('user_42');
    expect(encoded).not.toBe('user_42'); // opaque
    expect(decodeCursor(encoded)).toBe('user_42');
    expect(decodeCursor(encodeCursor(100))).toBe('100');
  });

  it('decodeCursor returns null for a malformed cursor (source-faithful)', () => {
    expect(decodeCursor('!!!not base64!!!')).toBeNull();
  });

  it('resolveCursor throws InputValidationException for a malformed cursor', () => {
    expect(() => resolveCursor('!!!not base64!!!')).toThrow(InputValidationException);
    expect(resolveCursor(encodeCursor('42'))).toBe('42');
  });
});

describe('buildCursorPageInfo', () => {
  const rows = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' }, // overfetch sentinel (limit + 1)
  ];

  it('trims the overfetch sentinel and emits a next-only envelope with next_cursor', () => {
    const { items, result_info } = buildCursorPageInfo(3, rows, 'id', {
      totalCount: 7,
      cursorApplied: false,
    });
    expect(items.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(result_info).toEqual({
      page: 0,
      per_page: 3,
      total_count: 7,
      has_next_page: true,
      has_prev_page: false,
      next_cursor: encodeCursor('c'), // boundary = last returned row
    });
    // Next-only, Stripe-style: no total_pages, no prev_cursor.
    expect('total_pages' in result_info).toBe(false);
    expect('prev_cursor' in result_info).toBe(false);
  });

  it('omits next_cursor on the last page and reflects cursorApplied via has_prev_page', () => {
    const { items, result_info } = buildCursorPageInfo(3, [{ id: 'e' }, { id: 'f' }], 'id', {
      totalCount: 7,
      cursorApplied: true,
    });
    expect(items.map((r) => r.id)).toEqual(['e', 'f']);
    expect(result_info.has_next_page).toBe(false);
    expect(result_info.has_prev_page).toBe(true);
    expect(result_info.next_cursor).toBeUndefined();
  });

  it('omits total_count when not supplied', () => {
    const { result_info } = buildCursorPageInfo(3, rows, 'id');
    expect('total_count' in result_info).toBe(false);
    expect(result_info.has_prev_page).toBe(false);
  });
});

// Compound tokens are the engine format; scalar utilities cannot forge one.
describe('compound keyset tokens', () => {
  it('roundtrips Unicode, dates, booleans and null boundaries', () => {
    const date = new Date('2026-09-20T00:00:00Z');
    const fields = ['name', 'time', 'flag', 'empty', 'id'];
    const token = encodeKeyset(
      { fields, direction: 'desc' },
      { name: '東京🚀', time: date, flag: true, empty: null, id: 'a' },
    );
    expect(resolveKeyset(token, fields, 'desc').after).toEqual(['東京🚀', date, true, null, 'a']);
  });

  it('compares full tuples in both directions, with explicit null ordering', () => {
    const asc = { fields: ['rank', 'id'], direction: 'asc' as const, after: [1, 'a'] };
    expect(isAfterKeyset(asc, { rank: 1, id: 'b' })).toBe(true);
    expect(isAfterKeyset(asc, { rank: 1, id: 'a' })).toBe(false);
    expect(isAfterKeyset(asc, { rank: null, id: 'z' })).toBe(false);
    expect(isAfterKeyset({ ...asc, direction: 'desc' }, { rank: null, id: 'z' })).toBe(true);
  });

  it('rejects wrong order, wrong arity, invalid dates and non-scalars', () => {
    for (const values of [[1], [1, {}], [1, { date: 'bad' }]]) {
      const token = btoa(
        JSON.stringify({ v: 1, fields: ['rank', 'id'], direction: 'asc', values }),
      );
      expect(() => resolveKeyset(token, ['rank', 'id'], 'asc')).toThrow('Invalid cursor');
    }
    const token = encodeKeyset({ fields: ['rank', 'id'], direction: 'asc' }, { rank: 1, id: 'a' });
    expect(() => resolveKeyset(token, ['rank', 'id'], 'desc')).toThrow('Invalid cursor');
  });
});
