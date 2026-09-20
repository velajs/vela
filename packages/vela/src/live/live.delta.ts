import { DEFAULT_KEY_FIELD, encodeListDelta, encodeLiveEnvelope } from '@velajs/live-protocol';
import type { ServerLiveFrame } from '@velajs/live-protocol';
import type { CommitStamp, SubscriptionRecord } from './live.types';

const UTF8_ENCODER = new TextEncoder();

/** Size the canonical envelope that {@link LiveEngine} actually sends. */
const encodedWireBytes = (frame: ServerLiveFrame): number | undefined => {
  try {
    return UTF8_ENCODER.encode(encodeLiveEnvelope(frame)).byteLength;
  } catch {
    // An invalid/oversized candidate cannot win the wire-size comparison.
    return undefined;
  }
};

/**
 * Decide what one re-run puts on the wire — pure, so the contract is
 * unit-testable without sockets:
 *
 * - byte-identical to the baseline → `settled` (cursor still advances; this
 *   is what drops client optimistic layers for writes that didn't change the
 *   result);
 * - baseline exists and the shared codec can diff → whichever complete
 *   canonical wire envelope is smaller: a batched keyed `delta` or `data`;
 * - otherwise (first send after subscribe/resume, codec bailed, unparseable
 *   baseline) → full `data` snapshot.
 *
 * A tie goes to the snapshot: it is one full replacement for the client and
 * avoids paying delta-merge work without saving any bytes.
 */
export function encodeSubscriptionUpdate(
  record: SubscriptionRecord,
  json: string,
  result: unknown,
  stamp: CommitStamp,
  initial: boolean,
): ServerLiveFrame {
  const settled: ServerLiveFrame = {
    t: 'settled',
    sub: record.sub,
    cursor: stamp.cursor,
    epoch: stamp.epoch,
  };
  const snapshot: ServerLiveFrame = {
    t: 'data',
    sub: record.sub,
    snapshot: result,
    cursor: stamp.cursor,
    epoch: stamp.epoch,
  };

  if (!initial && record.lastJson !== undefined) {
    if (record.lastJson === json) return settled;

    let previous: unknown;
    let parsed = false;
    try {
      previous = JSON.parse(record.lastJson);
      parsed = true;
    } catch {
      // Unparseable baseline — fall through to a snapshot.
    }
    if (parsed) {
      const ops = encodeListDelta(previous, result, record.key ?? DEFAULT_KEY_FIELD);
      if (ops !== undefined) {
        if (ops.length === 0) return settled;
        const delta: ServerLiveFrame = {
          t: 'delta',
          sub: record.sub,
          ops,
          cursor: stamp.cursor,
          epoch: stamp.epoch,
        };
        const deltaBytes = encodedWireBytes(delta);
        const snapshotBytes = encodedWireBytes(snapshot);
        if (
          deltaBytes !== undefined &&
          (snapshotBytes === undefined || deltaBytes < snapshotBytes)
        ) {
          return delta;
        }
        return snapshot;
      }
    }
  }

  return snapshot;
}
