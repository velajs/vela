import { foldOptimistic } from './optimistic';
import type { OptimisticLayer } from './optimistic';
import { stableStringify } from './stable-key';

/**
 * One deduped live subscription: every `subscribe()` for the same
 * (query, args, room) joins a single state (one wire registration, N
 * callbacks), lunora `subscription.ts` style.
 */
export interface SubscriptionState {
  /** Wire subscription id — client-chosen, unique per client (thus per socket). */
  sub: string;
  query: string;
  args: unknown;
  argsKey: string;
  room: string;
  key?: string;
  /** Server acknowledged the registration. */
  acked: boolean;
  callbacks: Set<(value: unknown) => void>;
  errorCallbacks: Set<(error: { code: string; message: string; fatal: boolean }) => void>;
  layers: OptimisticLayer[];
  validateResult?: (value: unknown) => void;
  validationError?: string;
  /** Authoritative value with NO optimistic overlay. */
  serverBase: unknown;
  /** Distinguishes "no value yet" from an authoritative `undefined`-shaped value. */
  hasBase: boolean;
  serverCursor?: number;
  serverEpoch?: string;
  /**
   * Displayed value = serverBase folded through layers. Reassigned only when
   * something actually changed, so snapshot consumers (React's
   * useSyncExternalStore) get referentially stable reads between notifies.
   */
  lastValue: unknown;
}

export const subscriptionKey = (query: string, argsKey: string, room: string): string =>
  JSON.stringify([room, query, argsKey]);

export const argsKeyOf = (args: unknown): string => stableStringify(args ?? null);

let wireSeq = 0;

export function createSubscriptionState(
  query: string,
  args: unknown,
  room: string,
  key?: string,
): SubscriptionState {
  wireSeq += 1;
  return {
    sub: `s${wireSeq}`,
    query,
    args,
    argsKey: argsKeyOf(args),
    room,
    key,
    acked: false,
    callbacks: new Set(),
    errorCallbacks: new Set(),
    layers: [],
    serverBase: undefined,
    hasBase: false,
    serverCursor: undefined,
    serverEpoch: undefined,
    lastValue: undefined,
  };
}

/** Re-fold the displayed value; true when it changed (notify). */
export function refold(state: SubscriptionState): boolean {
  const next =
    state.layers.length === 0 && state.hasBase ? state.serverBase : foldOptimistic(state);
  if (next === state.lastValue) return false;
  const hasValue = state.hasBase || state.layers.length > 0;
  if (hasValue && !validateSnapshot(state, next)) {
    reportSchemaError(state);
    return false;
  }
  state.lastValue = next;
  return true;
}

export function notify(state: SubscriptionState): void {
  for (const callback of state.callbacks) {
    callback(state.lastValue);
  }
}

/** Check before mutating authoritative state or publishing optimistic values. */
export function validateSnapshot(state: SubscriptionState, value: unknown): boolean {
  try {
    state.validateResult?.(value);
    state.validationError = undefined;
    return true;
  } catch (error) {
    state.validationError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export function reportSchemaError(state: SubscriptionState): void {
  for (const callback of state.errorCallbacks)
    callback({
      code: 'LIVE_SCHEMA_INVALID',
      message: state.validationError ?? 'Invalid live result',
      fatal: false,
    });
}
