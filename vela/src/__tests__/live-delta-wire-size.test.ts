import { describe, expect, it } from 'vitest';

import { encodeListDelta, encodeLiveEnvelope, encodeSubscriptionUpdate } from '../live/index.js';
import type { CommitStamp, ServerLiveFrame, SubscriptionRecord } from '../live/index.js';

const UTF8_ENCODER = new TextEncoder();
const STAMP: CommitStamp = { cursor: 1, epoch: 'e' };

const recordFor = (previous: unknown): SubscriptionRecord => ({
  sub: 's',
  query: 'items.list',
  args: undefined,
  tags: ['items'],
  lastJson: JSON.stringify(previous),
});

const wireBytes = (frame: ServerLiveFrame): number =>
  UTF8_ENCODER.encode(encodeLiveEnvelope(frame)).byteLength;

const deltaCandidate = (
  previous: unknown,
  next: unknown,
  stamp: CommitStamp = STAMP,
): Extract<ServerLiveFrame, { t: 'delta' }> => {
  const ops = encodeListDelta(previous, next);
  if (ops === undefined) throw new Error('test fixture must be delta-expressible');
  return { t: 'delta', sub: 's', ops, cursor: stamp.cursor, epoch: stamp.epoch };
};

const snapshotCandidate = (
  next: unknown,
  stamp: CommitStamp = STAMP,
): Extract<ServerLiveFrame, { t: 'data' }> => ({
  t: 'data',
  sub: 's',
  snapshot: next,
  cursor: stamp.cursor,
  epoch: stamp.epoch,
});

describe('encodeSubscriptionUpdate wire-size selection', () => {
  it('uses a snapshot when a valid one-op delta is larger on the wire', () => {
    const previous = [{ id: 'a', n: 1 }];
    const next = [{ id: 'a', n: 2 }];

    expect(wireBytes(deltaCandidate(previous, next))).toBeGreaterThan(
      wireBytes(snapshotCandidate(next)),
    );
    expect(
      encodeSubscriptionUpdate(recordFor(previous), JSON.stringify(next), next, STAMP, false),
    ).toEqual(snapshotCandidate(next));
  });

  it('keeps explicit before ordering when an insert delta is cheaper', () => {
    const previous = [
      { id: 'a', payload: 'x'.repeat(1_000) },
      { id: 'z', payload: 'x'.repeat(1_000) },
    ];
    const next = [previous[0], { id: 'm', label: 'middle' }, previous[1]];

    const frame = encodeSubscriptionUpdate(
      recordFor(previous),
      JSON.stringify(next),
      next,
      STAMP,
      false,
    );

    expect(frame).toEqual({
      t: 'delta',
      sub: 's',
      ops: [{ op: 'insert', key: 'm', row: { id: 'm', label: 'middle' }, before: 'z' }],
      cursor: 1,
      epoch: 'e',
    });
    expect(wireBytes(frame)).toBeLessThan(wireBytes(snapshotCandidate(next)));
  });

  it('measures UTF-8 bytes rather than JavaScript string length', () => {
    const previous = [
      { id: 'a', n: 1 },
      { id: 'b', label: '€'.repeat(4) },
    ];
    const next = [
      { id: 'a', n: 2 },
      { id: 'b', label: '€'.repeat(4) },
    ];
    const delta = deltaCandidate(previous, next);
    const snapshot = snapshotCandidate(next);

    // UTF-16 code units choose the snapshot; the actual UTF-8 wire bytes choose
    // the delta because its changed row does not contain the multibyte text.
    expect(encodeLiveEnvelope(delta).length).toBeGreaterThanOrEqual(
      encodeLiveEnvelope(snapshot).length,
    );
    expect(wireBytes(delta)).toBeLessThan(wireBytes(snapshot));
    expect(
      encodeSubscriptionUpdate(recordFor(previous), JSON.stringify(next), next, STAMP, false),
    ).toEqual(delta);
  });

  it('uses the snapshot when the canonical envelopes tie', () => {
    const stamp: CommitStamp = { cursor: 0, epoch: 'e' };
    const previous = [
      { id: 'a', n: 1 },
      { id: 'b', label: 'x'.repeat(6) },
    ];
    const next = [
      { id: 'a', n: 2 },
      { id: 'b', label: 'x'.repeat(6) },
    ];
    const delta = deltaCandidate(previous, next, stamp);
    const snapshot = snapshotCandidate(next, stamp);

    expect(wireBytes(delta)).toBe(wireBytes(snapshot));
    expect(
      encodeSubscriptionUpdate(recordFor(previous), JSON.stringify(next), next, stamp, false),
    ).toEqual(snapshot);
  });
});
