/**
 * The single error taxonomy for `@velajs/storage`. Every driver maps its
 * provider/transport failures onto a {@link StorageErrorCode}; the facade's
 * capability gates throw `Unsupported`; the retry loop keys off
 * {@link StorageError.retryable}; and the HTTP controller maps codes to
 * status via its own `codeToHttp()` table.
 */
export type StorageErrorCode =
  | 'NotFound'
  | 'AccessDenied'
  | 'Unsupported'
  | 'ReadOnly'
  | 'InvalidKey'
  | 'InvalidRequest'
  | 'Conflict'
  | 'RateLimited'
  | 'Network'
  | 'Timeout'
  | 'Aborted'
  | 'Provider'
  | 'Parse';

/** Codes that are safe to retry by default (transient failures). */
const RETRYABLE: ReadonlySet<StorageErrorCode> = new Set<StorageErrorCode>([
  'Network',
  'RateLimited',
  'Timeout',
  'Provider',
]);

export interface StorageErrorOptions {
  cause?: unknown;
  /** Underlying HTTP status, when the failure came from a transport response. */
  status?: number;
  /** Override the default retryability implied by {@link StorageErrorCode}. */
  retryable?: boolean;
}

export class StorageError extends Error {
  override name = 'StorageError';
  readonly code: StorageErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(code: StorageErrorCode, message: string, options?: StorageErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.status = options?.status;
    this.retryable = options?.retryable ?? RETRYABLE.has(code);
  }

  /** Wrap an arbitrary thrown value as a `StorageError` (idempotent). */
  static wrap(e: unknown): StorageError {
    if (e instanceof StorageError) return e;
    if (isAbort(e)) return new StorageError('Aborted', 'operation aborted', { cause: e });
    return new StorageError('Provider', e instanceof Error ? e.message : String(e), { cause: e });
  }

  /** Map a transport status code to a `StorageError` (5xx/429 retryable). */
  static fromStatus(status: number, message: string, cause?: unknown): StorageError {
    const code: StorageErrorCode =
      status === 404
        ? 'NotFound'
        : status === 403 || status === 401
          ? 'AccessDenied'
          : status === 409
            ? 'Conflict'
            : status === 429
              ? 'RateLimited'
              : status >= 500
                ? 'Provider'
                : 'InvalidRequest';
    return new StorageError(code, message, {
      status,
      cause,
      retryable: status === 429 || status >= 500,
    });
  }
}

/** True for `AbortError`-shaped values (DOMException or `{ name: 'AbortError' }`). */
export function isAbort(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    (e as { name?: unknown }).name === 'AbortError'
  );
}
