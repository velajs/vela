import { StorageError, isAbort } from '../storage.error';
import type { RetryOptions } from '../storage.types';

// Retry/timeout/abort plumbing. Deliberately does NOT use `AbortSignal.any`
// (only added in Node 20.3 — `engines.node >= 20` allows 20.0–20.2) nor
// `AbortSignal.timeout`; both are re-implemented from `AbortController` +
// `setTimeout` so the package runs on every target from 20.0 up.

/**
 * Combine multiple abort signals into one. The result aborts as soon as any
 * input aborts, adopting that input's reason. Listeners are cleaned up on
 * first abort. `undefined` inputs are ignored.
 */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  const live = signals.filter((s): s is AbortSignal => s != null);

  const onAbort = (reason: unknown) => {
    cleanup();
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const cleanup = () => {
    for (const s of live) s.removeEventListener('abort', handlers.get(s)!);
  };
  const handlers = new Map<AbortSignal, () => void>();

  for (const s of live) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    const h = () => onAbort(s.reason);
    handlers.set(s, h);
    s.addEventListener('abort', h, { once: true });
  }
  return controller.signal;
}

/** A controller that aborts after `ms`; call `clear()` to cancel the timer. */
export function timeoutController(ms: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new StorageError('Timeout', `operation timed out after ${ms}ms`));
  }, ms);
  return { controller, clear: () => clearTimeout(timer) };
}

/** Resolve after `ms`, or reject with `Aborted` if `signal` fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StorageError('Aborted', 'operation aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StorageError('Aborted', 'operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface NormalizedRetry {
  max: number;
  backoff: (ctx: { attempt: number; error: StorageError }) => number;
}

const DEFAULT_BASE_MS = 100;
const DEFAULT_CAP_MS = 2000;

function defaultBackoff({ attempt }: { attempt: number }): number {
  const expo = Math.min(DEFAULT_CAP_MS, DEFAULT_BASE_MS * 2 ** (attempt - 1));
  return expo + Math.floor(Math.random() * DEFAULT_BASE_MS); // full-ish jitter
}

export function normalizeRetry(retries: RetryOptions | undefined): NormalizedRetry {
  if (retries == null) return { max: 0, backoff: defaultBackoff };
  if (typeof retries === 'number') return { max: Math.max(0, retries), backoff: defaultBackoff };
  return { max: Math.max(0, retries.max), backoff: retries.backoff ?? defaultBackoff };
}

export interface RunOptions {
  retries?: RetryOptions;
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Run `fn` with per-attempt timeout, caller-abort propagation, and
 * retryable-error backoff. `fn` receives the combined per-attempt signal.
 *
 * - Caller-abort (`opts.signal`) → `Aborted`, never retried.
 * - Per-attempt timeout → `Timeout` (retryable by default, within budget).
 * - Only errors with `error.retryable` are retried, up to `retries.max`.
 */
export async function runWithRetry<T>(
  fn: (signal: AbortSignal | undefined) => Promise<T>,
  opts: RunOptions,
  onRetry?: (info: { attempt: number; delayMs: number; error: StorageError }) => void,
): Promise<T> {
  const { max, backoff } = normalizeRetry(opts.retries);
  const useTimeout = typeof opts.timeout === 'number' && opts.timeout > 0;

  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new StorageError('Aborted', 'operation aborted');

    const to = useTimeout ? timeoutController(opts.timeout!) : undefined;
    const signal = to ? anySignal([opts.signal, to.controller.signal]) : opts.signal;

    try {
      return await fn(signal);
    } catch (e) {
      // Hard caller cancellation: never retried.
      if (opts.signal?.aborted)
        throw new StorageError('Aborted', 'operation aborted', { cause: e });

      const error =
        to?.controller.signal.aborted && isAbort(e)
          ? new StorageError('Timeout', `operation timed out after ${opts.timeout}ms`, { cause: e })
          : StorageError.wrap(e);

      if (attempt >= max || !error.retryable) throw error;

      attempt += 1;
      const delayMs = Math.max(0, backoff({ attempt, error }));
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, opts.signal);
    } finally {
      to?.clear();
    }
  }
}
