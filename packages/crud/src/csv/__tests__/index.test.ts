import { describe, expect, it } from 'vitest';
import { csvToJson, escapeCsvValue, generateCsv, jsonToCsv, parseCsv } from '../index';

describe('escapeCsvValue', () => {
  it('passes through plain strings and numbers', () => {
    expect(escapeCsvValue('hello')).toBe('hello');
    expect(escapeCsvValue(42)).toBe('42');
  });

  it('renders null/undefined as the null value (default empty)', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
    expect(escapeCsvValue(null, { nullValue: 'NULL' })).toBe('NULL');
  });

  it('renders booleans as literals', () => {
    expect(escapeCsvValue(true)).toBe('true');
    expect(escapeCsvValue(false)).toBe('false');
  });

  it('quotes values containing the delimiter, quotes, or newlines', () => {
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
    expect(escapeCsvValue('she said "hi"')).toBe('"she said ""hi"""');
    expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
  });

  it('guards against CSV formula injection with a leading TAB inside quotes', () => {
    expect(escapeCsvValue('=SUM(A1)')).toBe('"\t=SUM(A1)"');
    expect(escapeCsvValue('+1')).toBe('"\t+1"');
    expect(escapeCsvValue('@cmd')).toBe('"\t@cmd"');
    // Leading '-' triggers the guard too (so negative numbers get quoted+tabbed).
    expect(escapeCsvValue('-5')).toBe('"\t-5"');
  });

  it('serializes objects and arrays as JSON, then escapes', () => {
    expect(escapeCsvValue({ foo: 'bar' })).toBe('"{""foo"":""bar""}"');
    expect(escapeCsvValue([1, 2, 3])).toBe('"[1,2,3]"');
  });

  it('renders dates by dateFormat (iso default)', () => {
    const date = new Date('2020-01-02T03:04:05.000Z');
    expect(escapeCsvValue(date)).toBe('2020-01-02T03:04:05.000Z');
    expect(escapeCsvValue(date, { dateFormat: 'timestamp' })).toBe(String(date.getTime()));
  });
});

describe('generateCsv', () => {
  it('emits a CRLF-delimited header + rows', () => {
    const csv = generateCsv([
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);
    expect(csv).toBe('id,name\r\n1,Alice\r\n2,Bob');
  });

  it('returns the empty string for no records (no header row)', () => {
    expect(generateCsv([])).toBe('');
  });

  it('honors excludeFields', () => {
    const csv = generateCsv([{ id: '1', name: 'Alice', secret: 'x' }], {
      excludeFields: ['secret'],
    });
    expect(csv).toBe('id,name\r\n1,Alice');
  });

  it('takes columns from the first record in insertion order', () => {
    const csv = generateCsv([{ b: '2', a: '1' }]);
    expect(csv.split('\r\n')[0]).toBe('b,a');
  });
});

describe('parseCsv', () => {
  it('parses a header row into record keys, cells stay strings', () => {
    const result = parseCsv('id,name\r\n1,Alice\r\n2,Bob');
    expect(result.headers).toEqual(['id', 'name']);
    expect(result.data).toEqual([
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);
  });

  it('does NOT coerce numeric/boolean cells', () => {
    expect(parseCsv('n,b\r\n42,true').data).toEqual([{ n: '42', b: 'true' }]);
  });

  it('handles quoted fields with embedded commas, quotes, and newlines', () => {
    expect(parseCsv('id,note\r\n1,"a,b"').data).toEqual([{ id: '1', note: 'a,b' }]);
    expect(parseCsv('id,q\r\n1,"she said ""hi"""').data).toEqual([{ id: '1', q: 'she said "hi"' }]);
    expect(parseCsv('id,m\r\n1,"line1\nline2"').data).toEqual([{ id: '1', m: 'line1\nline2' }]);
  });

  it('handles CRLF, CR, and LF line breaks', () => {
    expect(parseCsv('a\n1\n2').data).toEqual([{ a: '1' }, { a: '2' }]);
    expect(parseCsv('a\r1\r2').data).toEqual([{ a: '1' }, { a: '2' }]);
  });

  it('back-fills missing trailing fields and drops extras', () => {
    expect(parseCsv('a,b\r\n1').data).toEqual([{ a: '1', b: '' }]);
    expect(parseCsv('a,b\r\n1,2,3').data).toEqual([{ a: '1', b: '2' }]);
  });

  it('skips blank rows and maps empty cells by emptyValue', () => {
    expect(parseCsv('a\r\n1\r\n\r\n2').data).toEqual([{ a: '1' }, { a: '2' }]);
    expect(parseCsv('a,b\r\n1,', { emptyValue: 'null' }).data).toEqual([{ a: '1', b: null }]);
  });
});

describe('round-trip', () => {
  it('generate → parse recovers string values (incl. escaping edge cases)', () => {
    const rows = [
      { id: '1', note: 'a,b', quote: 'she said "hi"', multi: 'line1\nline2' },
      { id: '2', note: 'plain', quote: 'none', multi: 'single' },
    ];
    const parsed = parseCsv(generateCsv(rows)).data;
    expect(parsed).toEqual(rows);
  });

  it('jsonToCsv / csvToJson are the convenience inverses', () => {
    const rows = [{ id: '1', name: 'Alice' }];
    expect(csvToJson(jsonToCsv(rows))).toEqual(rows);
  });
});
