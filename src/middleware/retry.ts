import { isStream } from '../internal/body';
import { runWithRetry } from '../internal/retry';
import type { OperationOptions, RetryOptions } from '../storage.types';
import { passthrough, type Middleware } from './wrap';

export interface RetryMiddlewareOptions {
  /** Default retry policy for driver operations. Per-call `opts.retries` wins. */
  retries?: RetryOptions;
}

/**
 * Retry transient failures at the driver level. Reads and idempotent ops
 * always retry; an upload retries only when its body is replayable (not a
 * one-shot stream). Note: the `Storage` facade also retries per
 * `OperationOptions.retries` — use this middleware when driving a driver
 * directly, or set the facade's retries to 0 to avoid compounding.
 */
export function retry(opts: RetryMiddlewareOptions = {}): Middleware {
  const base = opts.retries ?? 3;
  const run = <T>(o: OperationOptions | undefined, fn: (s?: AbortSignal) => Promise<T>) =>
    runWithRetry(fn, { retries: o?.retries ?? base, timeout: o?.timeout, signal: o?.signal });

  return (inner) =>
    passthrough(inner, {
      download: (k, o) => run(o, (s) => inner.download(k, { ...o, signal: s })),
      head: (k, o) => run(o, (s) => inner.head(k, { ...o, signal: s })),
      exists: (k, o) => run(o, (s) => inner.exists(k, { ...o, signal: s })),
      list: (o) => run(o, (s) => inner.list({ ...o, signal: s })),
      delete: (k, o) => run(o, (s) => inner.delete(k, { ...o, signal: s })),
      copy: (f, t, o) => run(o, (s) => inner.copy(f, t, { ...o, signal: s })),
      upload: (k, b, o) => (isStream(b) ? inner.upload(k, b, o) : run(o, (s) => inner.upload(k, b, { ...o, signal: s }))),
    });
}
