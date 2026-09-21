/**
 * The single error taxonomy for `@velajs/mail`. Guards, the build pipeline, the
 * transports, and the inbound gate all throw a {@link MailError}; the `internal`
 * flag mirrors `@velajs/storage`'s redaction semantics so provider/transport
 * detail is never echoed to a client.
 */
export type MailErrorCode =
  | 'invalid_address'
  | 'invalid_header'
  | 'invalid_message'
  | 'no_transport'
  | 'queue_required'
  | 'render_failed'
  | 'provider_error'
  | 'inbound_malformed'
  | 'inbound_rejected';

export interface MailErrorOptions {
  cause?: unknown;
  /** Underlying HTTP status, when the failure came from a transport response. */
  status?: number;
  /**
   * True when `message` originates from a provider/transport rather than being
   * authored as client-safe text — callers and HTTP layers MUST redact it. A
   * bare `new MailError(code, msg)` vouches that `msg` is client-safe; transport
   * code echoing provider detail sets this. Default false.
   */
  internal?: boolean;
}

export class MailError extends Error {
  override name = 'MailError';
  readonly code: MailErrorCode;
  readonly status: number | undefined;
  /** Whether `message` is non-client-safe (provider/transport origin). */
  readonly internal: boolean;

  constructor(code: MailErrorCode, message: string, options?: MailErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.status = options?.status;
    this.internal = options?.internal ?? false;
  }
}
