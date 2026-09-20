/**
 * Studio error wire shape + the closed catalog of Studio-specific error codes.
 *
 * `AdminErrorBody` is a STRUCTURAL MIRROR of `@velajs/errors` `WireErrorObject`
 * (`errors/src/to-error-body.ts`), enriched with the `title` and `status` the
 * UI renders directly off the error envelope. The server enriches a
 * `WireErrorObject` (from `toErrorBody`) into this shape; a drift guard asserting
 * field compatibility lives in the server package.
 */

/**
 * The client-bound error body carried by a failed {@link AdminRpcResponse}.
 *
 * Shared fields (`code`, `message`, `hint`, `docsUrl`, `details`) mirror
 * `WireErrorObject`; `title` and `status` are the Studio-facing enrichment.
 */
export interface AdminErrorBody {
  /** Stable, dot/underscore-namespaced machine code (e.g. `STUDIO_DISABLED`). */
  code: string;
  /** Human-readable, catalog-sourced summary of the error class. */
  title: string;
  /** HTTP status this error maps to. */
  status: number;
  /** Redaction-safe message (unbranded errors carry only their status title). */
  message: string;
  /** Optional actionable remediation hint. */
  hint?: string;
  /** Optional link to documentation for this error class. */
  docsUrl?: string;
  /** Optional wire-encoded structured data (mirrors `WireErrorObject.details`). */
  details?: unknown;
}

/**
 * The structured payload carried on {@link AdminErrorBody.details} of a
 * `STUDIO_CONFIRM_REQUIRED` (428) error — the server's challenge for a
 * destructive op. The client re-sends the identical op args plus
 * {@link StudioConfirmChallenge.confirmToken} to complete the op.
 *
 * The token is single-use and payload-bound (see the server confirm signer);
 * `summary` is a human line the op handler supplies for the confirm dialog.
 * This is the canonical wire shape for the challenge — producers (server,
 * test fixtures) and consumers (UI decode) MUST use this type rather than
 * re-declaring it, so the two ends cannot drift.
 */
export interface StudioConfirmChallenge {
  /** Single-use, op+payload-bound token to echo back on the confirmed retry. */
  confirmToken: string;
  /** Epoch-ms after which the token is rejected. */
  expiresAt: number;
  /** Human-readable description of what the confirmed op will do. */
  summary: string;
}

/**
 * The closed set of Studio-specific error codes. `const` array + derived union
 * so the compile-time type and any runtime membership check can never drift.
 * Parenthetical statuses document the intended HTTP mapping (the wire carries
 * the concrete status on {@link AdminErrorBody}).
 */
export const STUDIO_ERROR_CODES = [
  /** Studio surface disabled (no token configured). */
  'STUDIO_DISABLED',
  /** Missing or invalid bearer token (401). */
  'STUDIO_UNAUTHORIZED',
  /** Dispatch target op is not registered (404). */
  'STUDIO_UNKNOWN_OP',
  /** Op recognized but forbidden for this principal/config (403). */
  'STUDIO_OP_FORBIDDEN',
  /** Ephemeral WS sub-token failed verification (401). */
  'STUDIO_SUB_TOKEN_INVALID',
  /** Per-IP token bucket exhausted (429). */
  'STUDIO_RATE_LIMITED',
  /** A confirmation token is required for this destructive op (428). */
  'STUDIO_CONFIRM_REQUIRED',
  /** Referenced data model is unknown (404). */
  'STUDIO_UNKNOWN_MODEL',
  /** Data editing is disabled (read-only Studio) (403). */
  'DATA_EDIT_DISABLED',
  /** Time travel is unavailable in this environment (409). */
  'TIMETRAVEL_UNAVAILABLE',
  /** Snapshot schema is incompatible with the current model (409). */
  'TIMETRAVEL_SCHEMA_MISMATCH',
  /** The backing feature/package is present but not configured (404). */
  'FEATURE_UNCONFIGURED',
] as const;

/** Union of every Studio-specific error code. */
export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[number];
