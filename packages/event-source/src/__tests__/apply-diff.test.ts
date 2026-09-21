import { describe, expect, it } from 'vitest';
import {
  applyDiff,
  applyDiffs,
  applyDiffToSnapshot,
  createTableDiff,
  type RowChange,
} from '../index';

const rowMap = (entries: [string, Record<string, unknown>][]) => new Map(entries);

describe('applyDiff', () => {
  it('applies insert/update/delete in order (golden)', () => {
    const before = rowMap([['1', { name: 'ada' }]]);
    const diff = createTableDiff('users', [
      { op: 'insert', key: '2', row: { name: 'bo' } },
      { op: 'update', key: '1', row: { name: 'ada-2' } },
      { op: 'delete', key: '3' },
    ]);
    const after = applyDiff(before, diff);
    expect([...after.entries()]).toEqual([
      ['1', { name: 'ada-2' }],
      ['2', { name: 'bo' }],
    ]);
  });

  it('does not mutate the input map', () => {
    const before = rowMap([['1', { name: 'ada' }]]);
    applyDiff(before, createTableDiff('t', [{ op: 'delete', key: '1' }]));
    expect(before.has('1')).toBe(true);
  });

  it('update patches onto existing rows and skips missing ones', () => {
    const before = rowMap([['1', { name: 'ada', age: 3 }]]);
    const after = applyDiff(
      before,
      createTableDiff('t', [
        { op: 'update', key: '1', row: { age: 4 } },
        { op: 'update', key: 'ghost', row: { age: 9 } },
      ]),
    );
    expect(after.get('1')).toEqual({ name: 'ada', age: 4 });
    expect(after.has('ghost')).toBe(false);
  });

  it('is idempotent: re-inserting replaces, re-deleting is a no-op', () => {
    const diff = createTableDiff('t', [
      { op: 'insert', key: '1', row: { n: 1 } },
      { op: 'delete', key: '2' },
    ]);
    const once = applyDiff(rowMap([['2', { n: 2 }]]), diff);
    const twice = applyDiff(once, diff);
    expect([...twice.entries()]).toEqual([['1', { n: 1 }]]);
  });

  it('insert copies the row rather than aliasing it', () => {
    const source: Record<string, unknown> = { n: 1 };
    const change: RowChange = { op: 'insert', key: '1', row: source };
    const after = applyDiff(rowMap([]), createTableDiff('t', [change]));
    source.n = 99;
    expect(after.get('1')).toEqual({ n: 1 });
  });
});

describe('applyDiffs', () => {
  it('folds an ordered list in a single pass', () => {
    const after = applyDiffs(rowMap([]), [
      createTableDiff('t', [{ op: 'insert', key: '1', row: { n: 1 } }]),
      createTableDiff('t', [{ op: 'update', key: '1', row: { n: 2 } }]),
    ]);
    expect(after.get('1')).toEqual({ n: 2 });
  });
});

describe('applyDiffToSnapshot', () => {
  it('updates only the diff table and leaves others intact', () => {
    const snapshot = new Map([
      ['users', rowMap([['1', { name: 'ada' }]])],
      ['posts', rowMap([['p1', { title: 'hi' }]])],
    ]);
    const next = applyDiffToSnapshot(
      snapshot,
      createTableDiff('users', [{ op: 'insert', key: '2', row: { name: 'bo' } }]),
    );
    expect([...next.get('users')!.keys()]).toEqual(['1', '2']);
    expect([...next.get('posts')!.keys()]).toEqual(['p1']);
    // Original snapshot untouched.
    expect([...snapshot.get('users')!.keys()]).toEqual(['1']);
  });

  it('creates the table map when the diff targets a new table', () => {
    const next = applyDiffToSnapshot(
      new Map(),
      createTableDiff('fresh', [{ op: 'insert', key: '1', row: { n: 1 } }]),
    );
    expect(next.get('fresh')!.get('1')).toEqual({ n: 1 });
  });
});
