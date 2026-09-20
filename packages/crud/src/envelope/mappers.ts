/**
 * Error-mapping pipeline used at the engine's response boundary
 * (hono-crud 0.13 `createErrorHandler` parity).
 *
 * Any thrown value is resolved to a canonical `{ structured, status }` pair by
 * {@link resolveStructuredError}; the response boundary then feeds `structured`
 * to the active `ResponseEnvelope.error(...)` and replies with `status`. The
 * precedence chain — custom mappers → `CrudException` → Zod-shaped → masked 500
 * — matches hono-crud's handler so migrating apps see byte-identical bodies.
 */

import type { ErrorMapper } from './envelope';
import {
  CrudException,
  InputValidationException,
  type CrudErrorCode,
  type StructuredError,
} from './errors';

/**
 * The generic message emitted for any unmapped error. NEVER contains the
 * original error's text — internals (stack frames, driver messages, secrets in
 * interpolated SQL) must not leak to clients. Byte-identical to hono-crud's
 * `defaultErrorMessage`.
 */
export const INTERNAL_ERROR_MESSAGE = 'An internal error occurred';

/**
 * Default HTTP status for a known {@link CrudErrorCode}. Unknown/custom codes
 * fall through to 500 — a custom mapper that wants a different status for its
 * own code should return the status via its own path (the boundary reads this
 * table only for the code it produced).
 *
 * Verified against hono-crud's per-exception constructors: `TENANT_REQUIRED`
 * is a 400 (`ApiException(config.errorMessage, 400, 'TENANT_REQUIRED')`),
 * `AGGREGATION_ERROR`/`VALIDATION_ERROR` are 400, and
 * `CONFIGURATION_ERROR`/`CACHE_ERROR`/`INTERNAL_ERROR` are 500.
 */
export function statusForCode(code: CrudErrorCode): number {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'AGGREGATION_ERROR':
    case 'TENANT_REQUIRED':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'CONFIGURATION_ERROR':
    case 'CACHE_ERROR':
    case 'INTERNAL_ERROR':
      return 500;
    default:
      return 500;
  }
}

/** Structural guard for a Zod-shaped error: carries an `issues` array. */
function isZodShaped(
  error: unknown,
): error is { issues: Array<{ path: Array<PropertyKey>; message: string; code: string }> } {
  return (
    typeof error === 'object' &&
    error !== null &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

/**
 * Resolve any thrown value to its canonical structured error + HTTP status.
 *
 * Precedence (first match wins):
 *   1. Custom `mappers` (in order) — the first that returns a defined
 *      `StructuredError` wins; its status comes from {@link statusForCode}.
 *      Mappers run BEFORE the built-ins so a driver-specific error (e.g. a
 *      unique-constraint violation → CONFLICT) can be reshaped even though it
 *      is neither a `CrudException` nor Zod-shaped. A throwing mapper is
 *      skipped (its own failure must not mask the original error).
 *   2. `CrudException` — its `.structured` payload + `.statusCode` are used
 *      verbatim (this also covers every subclass: NotFound, Conflict,
 *      InputValidation, ...).
 *   3. Zod-shaped error (has an `issues` array) — flattened to a
 *      `VALIDATION_ERROR` (400) with the `ValidationIssue[]` details, identical
 *      to `InputValidationException.fromZodError`.
 *   4. Anything else — a MASKED `INTERNAL_ERROR` (500). The original message is
 *      discarded so internals never reach the client.
 */
export function resolveStructuredError(
  error: unknown,
  mappers?: ErrorMapper[],
): { structured: StructuredError; status: number } {
  // 1. Custom mappers first — first non-undefined wins.
  if (mappers) {
    for (const mapper of mappers) {
      let mapped: StructuredError | undefined;
      try {
        mapped = mapper(error);
      } catch {
        // A mapper that throws is skipped — do not let it mask the error.
        continue;
      }
      if (mapped !== undefined) {
        return { structured: mapped, status: statusForCode(mapped.code) };
      }
    }
  }

  // 2. CrudException (and all subclasses) — use its own structured + status.
  if (error instanceof CrudException) {
    return { structured: error.structured, status: error.statusCode };
  }

  // 3. Zod-shaped errors — flatten to VALIDATION_ERROR 400.
  if (isZodShaped(error)) {
    const ex = InputValidationException.fromZodError(error);
    return { structured: ex.structured, status: ex.statusCode };
  }

  // 4. Everything else — masked internal 500 (never leak internals).
  return {
    structured: { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE },
    status: 500,
  };
}
