import { StorageError } from '../storage.error';
import type { RetryOptions } from '../storage.types';

/** Local cancellation ends the wait, not necessarily the provider operation. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new StorageError('Aborted', 'operation aborted', {
      cause: signal.reason,
      retryable: false,
    });
  }
}

/** Observe both settlements after cancellation and dispose late resources. */
function runAttempt<T>(
  fn: (signal: AbortSignal | undefined) => Promise<T>,
  opts: RunOptions,
  onDiscard?: (value: T) => void | Promise<void>,
): Promise<T> {
  throwIfAborted(opts.signal);
  const useTimeout = typeof opts.timeout === 'number' && opts.timeout > 0;
  if (!opts.signal && !useTimeout) return fn(undefined);

  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const cancel = (error: StorageError) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Settle before notifying a cooperative driver, so nested control layers
      // preserve this operation's Timeout/Aborted classification.
      reject(error);
      controller.abort(error);
    };
    const onAbort = () =>
      cancel(
        new StorageError('Aborted', 'operation aborted', {
          cause: opts.signal?.reason,
          retryable: false,
        }),
      );
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (useTimeout) {
      timer = setTimeout(
        () =>
          cancel(
            new StorageError('Timeout', `operation timed out after ${opts.timeout}ms`, {
              retryable: false,
            }),
          ),
        opts.timeout,
      );
    }
    // Keep the handlers attached to the provider promise even after cancellation.
    // A late rejection is observed; a late read body or upload handle is released.
    try {
      fn(controller.signal).then(
        (value) => {
          if (settled) {
            void Promise.resolve()
              .then(() => onDiscard?.(value))
              .catch(() => {});
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
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
 * - Local timeout → `Timeout`, never retried: the provider may still commit.
 * - Settled provider errors with `error.retryable` are retried, up to `retries.max`.
 */
export async function runWithRetry<T>(
  fn: (signal: AbortSignal | undefined) => Promise<T>,
  opts: RunOptions,
  onRetry?: (info: { attempt: number; delayMs: number; error: StorageError }) => void,
  onDiscard?: (value: T) => void | Promise<void>,
): Promise<T> {
  const { max, backoff } = normalizeRetry(opts.retries);
  let attempt = 0;
  for (;;) {
    try {
      return await runAttempt(fn, opts, onDiscard);
    } catch (e) {
      // Hard caller cancellation: never retried.
      if (opts.signal?.aborted)
        throw new StorageError('Aborted', 'operation aborted', { cause: e });

      const error = StorageError.wrap(e);

      if (attempt >= max || !error.retryable) throw error;

      attempt += 1;
      const delayMs = Math.max(0, backoff({ attempt, error }));
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, opts.signal);
    }
  }
}
