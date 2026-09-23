/**
 * The Studio error catalog + the single wire-redaction seam that turns any
 * thrown error into an {@link AdminErrorBody}. Studio codes are branded
 * `VelaError`s with safe, catalog-sourced titles; unbranded/internal errors are
 * redacted by `@velajs/errors` `toErrorBody` (their message never echoed).
 */
import { CORE_CATALOG, composeCatalogs, defineErrorCatalog, toErrorBody } from '@velajs/errors';
import type { VelaError } from '@velajs/errors';
import type { AdminErrorBody, StudioErrorCode } from '@velajs/studio-protocol';

/** Status + human title for every Studio-specific error code (statuses per the protocol doc). */
const STUDIO_ONLY_CATALOG = defineErrorCatalog({
  STUDIO_DISABLED: { status: 404, title: 'Studio Disabled' },
  STUDIO_UNAUTHORIZED: { status: 401, title: 'Unauthorized' },
  STUDIO_UNKNOWN_OP: { status: 404, title: 'Unknown Operation' },
  STUDIO_OP_FORBIDDEN: { status: 403, title: 'Operation Forbidden' },
  STUDIO_SUB_TOKEN_INVALID: { status: 401, title: 'Invalid Sub-Token' },
  STUDIO_RATE_LIMITED: { status: 429, title: 'Rate Limited' },
  STUDIO_CONFIRM_REQUIRED: { status: 428, title: 'Confirmation Required' },
  STUDIO_UNKNOWN_MODEL: { status: 404, title: 'Unknown Model' },
  DATA_EDIT_DISABLED: { status: 403, title: 'Data Editing Disabled' },
  TIMETRAVEL_UNAVAILABLE: { status: 409, title: 'Time Travel Unavailable' },
  TIMETRAVEL_SCHEMA_MISMATCH: { status: 409, title: 'Snapshot Schema Mismatch' },
  FEATURE_UNCONFIGURED: { status: 404, title: 'Feature Not Configured' },
});

/** Composed catalog: core codes (for redaction fallbacks) + Studio codes. */
export const STUDIO_CATALOG = composeCatalogs(CORE_CATALOG, STUDIO_ONLY_CATALOG);

/**
 * Construct a branded Studio error (status resolved from the catalog).
 * `data` rides the wire as `WireErrorObject.details` (the 428 confirm challenge
 * carries `{ confirmToken, expiresAt, summary }` there — no new wire shape).
 */
export function studioError(code: StudioErrorCode, message?: string, data?: unknown): VelaError {
  return STUDIO_CATALOG.error(code, {
    ...(message !== undefined ? { message } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}

/**
 * A 409 CONFLICT via the composed core `conflict` code — the Studio catalog has
 * no data-specific conflict code and the frozen protocol adds none, so writes
 * reuse the core code (wire `code: 'conflict'`, status 409). Used for
 * uniqueness violations and soft-delete-on-a-non-soft-delete model.
 */
export function studioConflict(message: string, hint?: string): VelaError {
  return STUDIO_CATALOG.error('conflict', {
    message,
    ...(hint !== undefined ? { hint } : {}),
  });
}

/** A 404 NOT FOUND via the composed core `not_found` code (an addressed row is absent). */
export function studioNotFound(message: string): VelaError {
  return STUDIO_CATALOG.error('not_found', { message });
}

/**
 * A portable time-travel restore that failed PARTWAY. The portable tier has no
 * cross-table transaction, so a mid-restore throw can leave tables partially
 * applied; the pre-captured `undoMark` id is the recovery target. Uses the core
 * `conflict` code (409, NON-internal) so the recovery id rides through the wire
 * redaction seam on `details.undoMark` — the client and audit must both learn
 * it. The underlying failure is attached as `cause` (server logs only; the
 * redaction seam never echoes `cause`).
 */
export function studioRestoreInterrupted(undoMarkId: string, cause: unknown): VelaError {
  return STUDIO_CATALOG.error('conflict', {
    message:
      'restore failed partway and may have left tables partially applied; ' +
      `recover by restoring to undo mark '${undoMarkId}'`,
    data: { undoMark: undoMarkId },
    cause,
  });
}

/**
 * A 400 BAD REQUEST via the composed core `bad_request` code — the Studio
 * catalog has no request-shape code and the frozen protocol adds none, so
 * request-validation guards reuse the core code (wire `code: 'bad_request'`,
 * status 400). Used for the `data.generateRows` count cap (a request over the
 * cap is a client error, not a silently clamped success).
 */
export function studioBadRequest(message: string, hint?: string): VelaError {
  return STUDIO_CATALOG.error('bad_request', {
    message,
    ...(hint !== undefined ? { hint } : {}),
  });
}

/**
 * A 415 UNSUPPORTED MEDIA TYPE via the composed core `unsupported_media_type`
 * code — the frozen protocol adds no code for it. Used when an admin request
 * carries a body under a non-JSON media type.
 */
export function studioUnsupportedMediaType(message: string): VelaError {
  return STUDIO_CATALOG.error('unsupported_media_type', { message });
}

/**
 * THE Studio error edge. Redacts through `toErrorBody`, then enriches the wire
 * object with the `title`/`status` the UI renders. Returns `redacted` so the
 * caller can log the raw error server-side.
 */
export function toAdminErrorBody(error: unknown): {
  body: AdminErrorBody;
  status: number;
  redacted: boolean;
} {
  const { body, status, redacted } = toErrorBody(error, { catalog: STUDIO_CATALOG });
  const wire = body.error;
  const title = STUDIO_CATALOG.get(wire.code)?.title ?? `HTTP ${status}`;
  return { body: { ...wire, title, status }, status, redacted };
}
