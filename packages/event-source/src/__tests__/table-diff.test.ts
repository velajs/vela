import { describe, expect, it } from 'vitest';
import {
  createTableDiff,
  diffSize,
  isDiffEmpty,
  mergeDiffs,
  partitionChanges,
  type RowChange,
  type TableDiff,
} from '../index';

const changes: RowChange[] = [
  { op: 'insert', key: 'a', row: { name: 'ada' } },
  { op: 'update', key: 'b', row: { name: 'bo' } },
  { op: 'delete', key: 'c' },
];

describe('table diff helpers', () => {
  it('createTableDiff stamps a timestamp and carries changes', () => {
    const diff = createTableDiff('users', changes, 123);
    expect(diff).toEqual({ table: 'users', changes, timestamp: 123 });
  });

  it('isDiffEmpty / diffSize reflect change count', () => {
    expect(isDiffEmpty(createTableDiff('t', []))).toBe(true);
    expect(isDiffEmpty(createTableDiff('t', changes))).toBe(false);
    expect(diffSize(createTableDiff('t', changes))).toBe(3);
  });

  it('partitionChanges splits by op', () => {
    const parts = partitionChanges(createTableDiff('t', changes));
    expect(parts.inserts.map((c) => c.key)).toEqual(['a']);
    expect(parts.updates.map((c) => c.key)).toEqual(['b']);
    expect(parts.deletes.map((c) => c.key)).toEqual(['c']);
  });

  it('mergeDiffs concatenates same-table changes and keeps the latest timestamp', () => {
    const first = createTableDiff('t', [{ op: 'insert', key: 'a', row: {} }], 1);
    const second = createTableDiff('t', [{ op: 'delete', key: 'a' }], 5);
    const merged = mergeDiffs([first, second]);
    expect(merged).toEqual({
      table: 't',
      changes: [
        { op: 'insert', key: 'a', row: {} },
        { op: 'delete', key: 'a' },
      ],
      timestamp: 5,
    });
  });

  it('mergeDiffs returns null on empty input', () => {
    expect(mergeDiffs([])).toBeNull();
  });

  it('RowChange mirrors the live-protocol op/key/row vocabulary', () => {
    // A field-for-field bridge onto @velajs/live-protocol RowOp (minus `before`).
    const insert: Extract<RowChange, { op: 'insert' }> = { op: 'insert', key: 'k', row: { v: 1 } };
    const del: Extract<RowChange, { op: 'delete' }> = { op: 'delete', key: 'k' };
    const asRowOp = { op: insert.op, key: insert.key, row: insert.row, before: null };
    expect(asRowOp).toEqual({ op: 'insert', key: 'k', row: { v: 1 }, before: null });
    expect(del).toEqual({ op: 'delete', key: 'k' });
  });
});

// A TableDiff is immutable-by-type: changes is a readonly array.
const typedDiff: TableDiff = createTableDiff('t', changes);
void typedDiff;
