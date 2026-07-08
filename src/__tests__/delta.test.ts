import { describe, expect, it } from 'vitest';

import { applyListDelta, encodeListDelta } from '../delta';
import type { RowOp } from '../frames';

describe('encodeListDelta', () => {
  it('returns an empty op list when nothing changed at row granularity', () => {
    const rows = [{ id: 'a', n: 1 }];
    expect(encodeListDelta(rows, rows)).toEqual([]);
  });

  it('orders deletes before inserts/updates', () => {
    const ops = encodeListDelta(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ id: 'b', n: 2 }, { id: 'c' }, { id: 'd' }],
    ) as RowOp[];
    expect(ops.map((op) => op.op)).toEqual(['delete', 'update', 'insert']);
  });

  it('bails when the op count exceeds the next length (rule 5)', () => {
    expect(encodeListDelta([{ id: 'a' }, { id: 'b' }], [{ id: 'b', n: 2 }, { id: 'c' }])).toBeUndefined();
  });

  it('anchors an insert to the nearest following survivor', () => {
    const ops = encodeListDelta([{ id: 'a' }, { id: 'z' }], [{ id: 'a' }, { id: 'm' }, { id: 'z' }]);
    expect(ops).toEqual([{ op: 'insert', key: 'm', row: { id: 'm' }, before: 'z' }]);
  });

  it('bails when a row cannot be JSON-serialized', () => {
    const previous = [{ id: 'a', n: 1 }];
    const next = [{ id: 'a', n: BigInt(2) as unknown as number }];
    expect(encodeListDelta(previous, next)).toBeUndefined();
  });

  it('supports a custom key field', () => {
    const ops = encodeListDelta([{ pk: 'a', n: 1 }], [{ pk: 'a', n: 2 }], 'pk');
    expect(ops).toEqual([{ op: 'update', key: 'a', row: { pk: 'a', n: 2 } }]);
  });
});

describe('applyListDelta', () => {
  it('never mutates the input array', () => {
    const current = [{ id: 'a', n: 1 }];
    const snapshot = JSON.stringify(current);
    applyListDelta(current, [{ op: 'delete', key: 'a' }]);
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it('treats a delete of an absent key as a no-op', () => {
    expect(applyListDelta([{ id: 'a' }], [{ op: 'delete', key: 'zz' }])).toEqual([{ id: 'a' }]);
  });

  it('replaces in place when an insert replays over an existing row', () => {
    const merged = applyListDelta(
      [{ id: 'a', n: 1 }, { id: 'b' }],
      [{ op: 'insert', key: 'a', row: { id: 'a', n: 9 }, before: null }],
    );
    expect(merged).toEqual([{ id: 'a', n: 9 }, { id: 'b' }]);
  });

  it('appends when an insert anchor is gone (degraded replay)', () => {
    const merged = applyListDelta([{ id: 'a' }], [{ op: 'insert', key: 'x', row: { id: 'x' }, before: 'gone' }]);
    expect(merged).toEqual([{ id: 'a' }, { id: 'x' }]);
  });

  it('appends an update for a row this page never held', () => {
    const merged = applyListDelta([{ id: 'a' }], [{ op: 'update', key: 'x', row: { id: 'x', n: 1 } }]);
    expect(merged).toEqual([{ id: 'a' }, { id: 'x', n: 1 }]);
  });

  it('bails on a non-array cache', () => {
    expect(applyListDelta({ id: 'a' }, [{ op: 'delete', key: 'a' }])).toBeUndefined();
  });

  it('bails on unkeyable cached rows', () => {
    expect(applyListDelta([{ text: 'no key' }], [{ op: 'delete', key: 'a' }])).toBeUndefined();
  });

  it('bails on duplicate keys in the cache', () => {
    expect(applyListDelta([{ id: 'a' }, { id: 'a' }], [{ op: 'delete', key: 'a' }])).toBeUndefined();
  });
});
