import { isVelaError, type ErrorBodyResult } from '@velajs/errors';

/**
 * A predicate for classifying an error, used by {@link ExceptionHandler.dontReport}.
 *
 * Three shapes are accepted:
 * - `string` — a Vela error code; matches when the error is a branded
 *   `VelaError` whose `code` equals the string.
 * - a predicate `(error: unknown) => boolean` — **must be an arrow function**.
 *   A class and a predicate are both `typeof 'function'`; {@link matchesAny}
 *   discriminates on `prototype`, which arrow functions do not have.
 * - an error class constructor — matches via `instanceof`.
 */
export type ErrorMatcher = string | ((error: unknown) => boolean) | (new (...args: never[]) => Error);

/**
 * Ambient context handed to every reporting/rendering hook. `edge` names the
 * transport that caught the error; open-ended extra keys (via the index
 * signature) let a handler's `context()` enrich the payload.
 */
export interface ErrorReportContext {
  edge: 'http' | 'ws' | 'live' | 'queue' | 'schedule' | 'hono';
  /** e.g. `'CatsController.findAll'` or a query name. */
  source?: string;
  /** e.g. `'exception filter threw'`. */
  note?: string;
  [key: string]: unknown;
}

/**
 * The application-wide exception handler contract. Provide an implementation
 * under {@link APP_EXCEPTION_HANDLER} to customize how errors are reported and
 * rendered. Every member is optional — an empty object is a valid handler.
 */
export interface ExceptionHandler {
  /** Fire-and-forget reporting (logging, Sentry, …). May be async. */
  report?(error: unknown, ctx: ErrorReportContext): void | Promise<void>;
  /** Errors matching any of these are never reported. */
  dontReport?: ErrorMatcher[];
  /** Extra fields merged into the report context. Must be side-effect free. */
  context?(error: unknown, ctx: ErrorReportContext): Record<string, unknown>;
  /** Override the client-bound response for an error. */
  render?(error: unknown, ctx: unknown): Response | ErrorBodyResult | undefined;
}

/**
 * True when `error` matches any of `matchers`. A string matches a branded
 * {@link VelaError} by `code`; an arrow-function predicate is called; anything
 * else with a `prototype` is treated as an error class and matched via
 * `instanceof`. Predicates therefore MUST be arrow functions — a regular
 * `function` expression has a `prototype` and would be mistaken for a class.
 */
export const matchesAny = (matchers: ErrorMatcher[] | undefined, error: unknown): boolean => {
  if (!matchers?.length) return false;
  return matchers.some((m) => {
    if (typeof m === 'string') return isVelaError(error) && error.code === m;
    if (typeof m === 'function' && !m.prototype) return (m as (e: unknown) => boolean)(error);
    return error instanceof (m as new () => Error);
  });
};
