import { DEFAULT_KEY_FIELD, applyListDelta } from '@velajs/live-protocol';
import type { ServerLiveFrame } from '@velajs/live-protocol';
import { dropConfirmedLayers } from './optimistic';
import { refold, validateSnapshot } from './subscription';
import type { SubscriptionState } from './subscription';

/**
 * What the connection layer must do after a frame was applied:
 * - `notify` — the displayed value changed, fire callbacks;
 * - `resubscribe` — the cache is unusable (epoch fork mid-delta, unmergeable
 *   delta); send a fresh cold `sub` for this state;
 * - `error` — an error frame; route to error callbacks;
 * - `none` — bookkeeping only.
 */
export type FrameEffect = 'none' | 'notify' | 'resubscribe' | 'error' | 'invalid';

/** Apply a full snapshot from SSR/cross-tab through the same state machine as the socket. */
export function applySnapshotFrame(
  state: SubscriptionState,
  snapshot: unknown,
  cursor?: number,
  epoch?: string,
): FrameEffect {
  if (!isCursorEpochPair(cursor, epoch)) return 'resubscribe';
  return applyServerFrame(state, {
    t: 'data',
    sub: state.sub,
    snapshot,
    ...(cursor === undefined ? {} : { cursor, epoch: epoch! }),
  });
}

/**
 * The pure per-subscription frame state machine (adapts lunora's
 * `handleDataMessage`/`handleResumeMessage`/`handleSettledMessage`).
 * Deliberately socket-free so the protocol semantics are unit-testable.
 */
export function applyServerFrame(state: SubscriptionState, frame: ServerLiveFrame): FrameEffect {
  switch (frame.t) {
    case 'ack':
      state.acked = true;
      return 'none';

    case 'error':
      return 'error';

    case 'resume': {
      if (epochForked(state, frame.epoch)) return 'resubscribe';
      if (watermarkRegressed(state, frame.cursor, frame.epoch)) return 'none';
      // Nothing relevant changed while away: keep the cached value, advance
      // the watermark. Confirmed layers the new cursor covers still drop.
      state.serverCursor = frame.cursor;
      state.serverEpoch = frame.epoch;
      const dropped = dropConfirmedLayers(state, frame.cursor, frame.epoch);
      return dropped && refold(state) ? 'notify' : 'none';
    }

    case 'settled': {
      if (epochForked(state, frame.epoch) || missingWatermark(state, frame.cursor)) {
        return 'resubscribe';
      }
      if (watermarkRegressed(state, frame.cursor, frame.epoch)) return 'none';
      // Byte-identical re-run: no payload, but the cursor advance is what
      // drops optimistic layers for writes that didn't change this query.
      advanceWatermark(state, frame.cursor, frame.epoch);
      const dropped = dropConfirmedLayers(state, frame.cursor, frame.epoch);
      return dropped && refold(state) ? 'notify' : 'none';
    }

    case 'data': {
      if (missingWatermark(state, frame.cursor)) return 'resubscribe';
      if (watermarkRegressed(state, frame.cursor, frame.epoch)) return 'none';
      const snapshot = safeClone(frame.snapshot);
      if (snapshot === CLONE_FAILED) return 'resubscribe';
      if (!validateSnapshot(state, snapshot)) return 'invalid';
      if (epochForked(state, frame.epoch)) state.layers = [];
      state.serverBase = snapshot;
      state.hasBase = true;
      advanceWatermark(state, frame.cursor, frame.epoch);
      dropConfirmedLayers(state, frame.cursor, frame.epoch);
      refold(state);
      return 'notify';
    }

    case 'delta': {
      // A delta diffs against the baseline the server believes we confirmed —
      // across an epoch fork or without a base that belief is wrong by
      // construction: start over.
      if (
        epochForked(state, frame.epoch) ||
        !state.hasBase ||
        missingWatermark(state, frame.cursor)
      ) {
        return 'resubscribe';
      }
      if (watermarkRegressed(state, frame.cursor, frame.epoch)) return 'none';
      const merged = applyListDelta(state.serverBase, frame.ops, state.key ?? DEFAULT_KEY_FIELD);
      if (merged === undefined) return 'resubscribe';
      const snapshot = safeClone(merged);
      if (snapshot === CLONE_FAILED) return 'resubscribe';
      if (!validateSnapshot(state, snapshot)) return 'invalid';
      state.serverBase = snapshot;
      advanceWatermark(state, frame.cursor, frame.epoch);
      dropConfirmedLayers(state, frame.cursor, frame.epoch);
      refold(state);
      return 'notify';
    }
  }
}

const epochForked = (state: SubscriptionState, epoch?: string): boolean =>
  epoch !== undefined && state.serverEpoch !== undefined && epoch !== state.serverEpoch;

const missingWatermark = (state: SubscriptionState, cursor?: number): boolean =>
  state.serverCursor !== undefined && cursor === undefined;

const watermarkRegressed = (state: SubscriptionState, cursor?: number, epoch?: string): boolean =>
  cursor !== undefined &&
  state.serverCursor !== undefined &&
  epoch !== undefined &&
  epoch === state.serverEpoch &&
  cursor < state.serverCursor;

export const isCursorEpochPair = (cursor?: number, epoch?: string): boolean =>
  (cursor === undefined && epoch === undefined) ||
  (typeof cursor === 'number' &&
    Number.isSafeInteger(cursor) &&
    cursor >= 0 &&
    typeof epoch === 'string' &&
    epoch.length > 0 &&
    epoch.length <= 256);

const CLONE_FAILED = Symbol('clone failed');

const safeClone = (value: unknown): unknown | typeof CLONE_FAILED => {
  try {
    return structuredClone(value);
  } catch {
    return CLONE_FAILED;
  }
};

function advanceWatermark(state: SubscriptionState, cursor?: number, epoch?: string): void {
  if (cursor !== undefined) state.serverCursor = cursor;
  if (epoch !== undefined) state.serverEpoch = epoch;
}
