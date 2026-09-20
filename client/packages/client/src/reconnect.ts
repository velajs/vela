/**
 * Decorrelated exponential jitter (lunora `reconnect.ts` port): each retry
 * waits a random duration between the base and 3× the previous wait, capped.
 * Decorrelation avoids the reconnect stampede a fixed exponential schedule
 * produces when a fleet of clients drops at once.
 */
export interface ReconnectState {
  previousMs?: number;
}

export const DEFAULT_RECONNECT_BASE_MS = 250;
export const DEFAULT_RECONNECT_CAP_MS = 30_000;

export function nextReconnectDelay(
  state: ReconnectState,
  baseMs = DEFAULT_RECONNECT_BASE_MS,
  capMs = DEFAULT_RECONNECT_CAP_MS,
  random: () => number = Math.random,
): number {
  const high = Math.max(baseMs, (state.previousMs ?? baseMs) * 3);
  const delay = Math.min(capMs, baseMs + random() * (high - baseMs));
  state.previousMs = delay;
  return delay;
}

export function resetReconnect(state: ReconnectState): void {
  state.previousMs = undefined;
}
