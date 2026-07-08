import { DEFAULT_KEY_FIELD, applyListDelta } from '@velajs/live-protocol';
import type { ServerLiveFrame } from '@velajs/live-protocol';
import { dropConfirmedLayers } from './optimistic';
import { refold } from './subscription';
import type { SubscriptionState } from './subscription';

/**
 * What the connection layer must do after a frame was applied:
 * - `notify` — the displayed value changed, fire callbacks;
 * - `resubscribe` — the cache is unusable (epoch fork mid-delta, unmergeable
 *   delta); send a fresh cold `sub` for this state;
 * - `error` — an error frame; route to error callbacks;
 * - `none` — bookkeeping only.
 */
export type FrameEffect = 'none' | 'notify' | 'resubscribe' | 'error';

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
      // Nothing relevant changed while away: keep the cached value, advance
      // the watermark. Confirmed layers the new cursor covers still drop.
      state.serverCursor = frame.cursor;
      state.serverEpoch = frame.epoch;
      const dropped = dropConfirmedLayers(state, frame.cursor, frame.epoch);
      return dropped && refold(state) ? 'notify' : 'none';
    }

    case 'settled': {
      // Byte-identical re-run: no payload, but the cursor advance is what
      // drops optimistic layers for writes that didn't change this query.
      advanceWatermark(state, frame.cursor, frame.epoch);
      const dropped = dropConfirmedLayers(state, frame.cursor, frame.epoch);
      return dropped && refold(state) ? 'notify' : 'none';
    }

    case 'data': {
      if (epochForked(state, frame.epoch)) {
        // New timeline: every optimistic gate is void. The snapshot itself is
        // authoritative, so apply it as a cold first frame.
        state.layers = [];
      }
      state.serverBase = frame.snapshot;
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
      if (epochForked(state, frame.epoch) || !state.hasBase) return 'resubscribe';
      const merged = applyListDelta(state.serverBase, frame.ops, state.key ?? DEFAULT_KEY_FIELD);
      if (merged === undefined) return 'resubscribe';
      state.serverBase = merged;
      advanceWatermark(state, frame.cursor, frame.epoch);
      dropConfirmedLayers(state, frame.cursor, frame.epoch);
      refold(state);
      return 'notify';
    }
  }
}

const epochForked = (state: SubscriptionState, epoch?: string): boolean =>
  epoch !== undefined && state.serverEpoch !== undefined && epoch !== state.serverEpoch;

function advanceWatermark(state: SubscriptionState, cursor?: number, epoch?: string): void {
  if (cursor !== undefined) state.serverCursor = cursor;
  if (epoch !== undefined) state.serverEpoch = epoch;
}
