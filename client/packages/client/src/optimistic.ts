/**
 * Rebaseable, cursor-gated optimistic layers (lunora `optimistic-layers.ts`
 * port). The displayed value is ALWAYS the authoritative server base folded
 * through the pending layers, so:
 *
 * - an unrelated server frame re-folds the layers onto the new base instead of
 *   clobbering the optimistic state ("rebasing");
 * - a layer drops only when a subscription frame arrives whose cursor passes
 *   the mutation's commit cursor (same epoch) — NEVER on HTTP-response
 *   timing, which races the broadcast;
 * - confirm without a stamp (a non-live-aware endpoint) degrades to one-shot
 *   optimism: the layer drops silently and the next authoritative frame
 *   reconciles;
 * - rollback removes the layer and re-folds so the failed write's effect
 *   disappears immediately.
 */

export interface CommitStamp {
  cursor: number;
  epoch: string;
}

export interface OptimisticLayer {
  readonly id: symbol;
  readonly transform: (current: unknown) => unknown;
  /** Set by confirm(); the layer is dropped by the first frame whose cursor passes it. */
  commitCursor?: number;
  commitEpoch?: string;
}

/** The slice of subscription state the optimistic engine operates on. */
export interface OptimisticHost {
  layers: OptimisticLayer[];
  serverBase: unknown;
  hasBase: boolean;
  serverCursor?: number;
  serverEpoch?: string;
}

export const foldOptimistic = (host: OptimisticHost): unknown =>
  host.layers.reduce(
    (value, layer) => layer.transform(value),
    host.hasBase ? host.serverBase : undefined,
  );

export interface LayerHandle {
  /**
   * Record the mutation's commit stamp. With a stamp, the layer survives
   * until a frame's cursor passes it (dropping immediately when the current
   * frame already has). Without one, the layer is removed silently — no
   * re-fold, the incoming authoritative frame reconciles.
   */
  confirm(stamp?: CommitStamp): boolean;
  /** Remove the layer and report whether the host must re-fold + notify. */
  rollback(): boolean;
}

export function applyOptimisticLayer(
  host: OptimisticHost,
  transform: (current: unknown) => unknown,
): LayerHandle {
  const layer: OptimisticLayer = { id: Symbol('optimistic'), transform };
  host.layers.push(layer);

  const remove = (): boolean => {
    const index = host.layers.indexOf(layer);
    if (index === -1) return false;
    host.layers.splice(index, 1);
    return true;
  };

  return {
    confirm(stamp) {
      if (!stamp) {
        remove();
        return false;
      }
      // A stamp from a foreign epoch can never be gated — treat as unstamped.
      if (host.serverEpoch !== undefined && stamp.epoch !== host.serverEpoch) {
        remove();
        return false;
      }
      layer.commitCursor = stamp.cursor;
      layer.commitEpoch = stamp.epoch;
      // The confirming frame may already have passed while the HTTP response
      // was in flight — drop now and tell the caller to re-fold.
      if (host.serverCursor !== undefined && host.serverCursor >= stamp.cursor) {
        return remove();
      }
      return false;
    },
    rollback() {
      return remove();
    },
  };
}

/**
 * Drop every confirmed layer the frame at (cursor, epoch) covers. A layer
 * confirmed under a DIFFERENT epoch is also dropped — its gate can never fire
 * on this timeline. Returns whether any layer was removed (host re-folds).
 */
export function dropConfirmedLayers(
  host: OptimisticHost,
  cursor?: number,
  epoch?: string,
): boolean {
  if (cursor === undefined) return false;
  const before = host.layers.length;
  host.layers = host.layers.filter((layer) => {
    if (layer.commitCursor === undefined) return true; // still pending
    if (epoch !== undefined && layer.commitEpoch !== epoch) return false;
    return cursor < layer.commitCursor;
  });
  return host.layers.length !== before;
}
