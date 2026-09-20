/**
 * Pluggable response envelope (hono-crud 0.13 parity). The default is
 * byte-identical to the previous engine:
 *
 * - single result: `{ success: true, result }`
 * - list result:   `{ success: true, result, result_info: {...} }`
 * - error:         `{ success: false, error: { code, message, details? } }`
 */

import type { PageInfo } from '../adapter/query-types';
import type { StructuredError } from './errors';

/**
 * Pagination metadata handed to `ResponseEnvelope.success` for list/search
 * responses; open record so custom envelopes can carry extra info.
 */
export type ResponseEnvelopeInfo = PageInfo | Record<string, unknown>;

export interface ResponseEnvelope {
  /** Format every 2xx response body. `info` is set for list/search pages. */
  success: (result: unknown, info?: ResponseEnvelopeInfo) => unknown;
  /** Format an error body from the structured error (post error-mappers). */
  error: (err: StructuredError) => unknown;
}

export const defaultEnvelope: ResponseEnvelope = {
  success: (result, info) =>
    info !== undefined ? { success: true, result, result_info: info } : { success: true, result },
  error: (err) => ({ success: false, error: err }),
};

/**
 * An error mapper translates a raw unknown error into a `CrudException`-like
 * structured form before the envelope formats it (e.g. a driver's unique
 * constraint violation → CONFLICT). Return `undefined` to pass to the next
 * mapper.
 */
export type ErrorMapper = (error: unknown) => StructuredError | undefined;
