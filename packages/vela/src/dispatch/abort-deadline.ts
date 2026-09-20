/** A strongly-held timeout combined with an optional caller abort signal. */
export interface AbortDeadline {
  /** Clear the timer and detach the caller-signal listener. */
  dispose(): void;
  /** The signal to use for the bounded operation. */
  readonly signal: AbortSignal | undefined;
  /** Whether this deadline's own timer won the abort race. */
  timedOut(): boolean;
}

/**
 * Combine `signal` with a timeout whose controller is strongly reachable for
 * as long as its timer is pending.
 *
 * This deliberately does not use `AbortSignal.timeout()`: runtimes may hold
 * its timer weakly, allowing collection to silently turn a deadline into an
 * unbounded operation. The timer callback here closes over the controller, and
 * callers tear it down explicitly with {@link AbortDeadline.dispose}.
 */
export function abortDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  reason: () => unknown,
): AbortDeadline {
  if (timeoutMs === undefined || signal?.aborted === true) {
    return {
      dispose() {},
      signal,
      timedOut: () => false,
    };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutWon = false;

  const forwardCallerAbort = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(signal?.reason);
  };

  signal?.addEventListener('abort', forwardCallerAbort, { once: true });
  timer = setTimeout(() => {
    timeoutWon = true;
    controller.abort(reason());
  }, timeoutMs);

  return {
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', forwardCallerAbort);
    },
    signal: controller.signal,
    timedOut: () => timeoutWon,
  };
}
