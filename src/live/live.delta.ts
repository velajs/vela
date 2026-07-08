import { DEFAULT_KEY_FIELD, encodeListDelta } from '@velajs/live-protocol';
import type { ServerLiveFrame } from '@velajs/live-protocol';
import type { CommitStamp, SubscriptionRecord } from './live.types';

/**
 * Decide what one re-run puts on the wire — pure, so the contract is
 * unit-testable without sockets:
 *
 * - byte-identical to the baseline → `settled` (cursor still advances; this
 *   is what drops client optimistic layers for writes that didn't change the
 *   result);
 * - baseline exists and the shared codec can diff → `delta` (batched keyed
 *   row ops);
 * - otherwise (first send after subscribe/resume, codec bailed, unparseable
 *   baseline) → full `data` snapshot.
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
      if (ops !== undefined && ops.length > 0) {
        return { t: 'delta', sub: record.sub, ops, cursor: stamp.cursor, epoch: stamp.epoch };
      }
      if (ops !== undefined) return settled;
    }
  }

  return { t: 'data', sub: record.sub, snapshot: result, cursor: stamp.cursor, epoch: stamp.epoch };
}
