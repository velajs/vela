/** Portable terminal-error marker and optional adapter conversion. No native imports. */
/** Marker property tagging a value as this package's portable non-retryable error. */
const PORTABLE_NON_RETRYABLE_TAG = '__velaNonRetryable';

/**
 * Signals a terminal failure to an execution adapter. The replay harness honors
 * this marker; native adapters must perform their own platform conversion.
 *
 * ```ts
 * import { WorkflowNonRetryableError } from '@velajs/workflow';
 *
 * if (invoice.state === 'void') {
 *   throw new WorkflowNonRetryableError('invoice is void; a retry will never succeed');
 * }
 * ```
 */
export class WorkflowNonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') {
    super(message);
    // A custom diagnostic name does not remove the portable terminal marker.
    this.name = name;
    // Attached at runtime rather than declared as a class field, so the emitted
    // declaration file gains no extra member.
    (this as unknown as Record<string, unknown>)[PORTABLE_NON_RETRYABLE_TAG] = true;
  }
}

/** Narrows `value` to this package's portable {@link WorkflowNonRetryableError}. */
export const isNonRetryableError = (value: unknown): value is WorkflowNonRetryableError =>
  value instanceof Error &&
  (value as unknown as Record<string, unknown>)[PORTABLE_NON_RETRYABLE_TAG] === true;

/** The constructor signature of the platform's native `NonRetryableError`. */
export type NativeNonRetryableErrorConstructor = new (message: string, name?: string) => Error;

/**
 * Reconstruct a portable {@link WorkflowNonRetryableError} as the native
 * Cloudflare one, carrying over `stack` and `cause`. Cloudflare's
 * serialized error boundary recognizes the native terminal name; a custom
 * portable name prefixes the message instead of replacing the native name.
 */
export const toNativeNonRetryableError = (
  error: WorkflowNonRetryableError,
  Native: NativeNonRetryableErrorConstructor,
): Error => {
  const message =
    error.name === 'NonRetryableError' ? error.message : `${error.name}: ${error.message}`;
  const rebuilt = new Native(message, 'NonRetryableError');

  if (error.stack !== undefined) {
    rebuilt.stack = error.stack;
  }

  if (error.cause !== undefined && rebuilt.cause === undefined) {
    rebuilt.cause = error.cause;
  }

  return rebuilt;
};

/**
 * Re-throw `error`. If it is a portable {@link WorkflowNonRetryableError} and a
 * native constructor is available, throw the reconstructed native error instead;
 * every other value propagates untouched. The function always throws, and its
 * `never` return type lets a caller write `return convertNonRetryableError(...)`.
 */
export const convertNonRetryableError = (
  error: unknown,
  Native?: NativeNonRetryableErrorConstructor,
): never => {
  if (Native !== undefined && isNonRetryableError(error)) {
    throw toNativeNonRetryableError(error, Native);
  }

  throw error;
};
