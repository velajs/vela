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

/** Construct a branded Studio error (status resolved from the catalog). */
export function studioError(code: StudioErrorCode, message?: string): VelaError {
  return STUDIO_CATALOG.error(code, message !== undefined ? { message } : {});
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
