import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode, StatusCode } from 'hono/utils/http-status';
import type { ErrorReporter } from '../exceptions/reporter';
import { getErrorStatus, renderHttpError } from '../exceptions/render-http-error';
import { mapResponse } from './response-mapper';

/**
 * The HTTP response for a failure: the application's `ExceptionHandler.render`
 * hook, then {@link renderHttpError}. A Hono `HTTPException` below 500 built
 * with its own `res` keeps that response (for example an auth challenge with
 * its headers); one with only a message renders as JSON like any other error.
 */
export function sendHttpError(
  c: Context,
  error: unknown,
  reporter: ErrorReporter,
  host: unknown,
  redactServerBodies = false,
): Response {
  const rendered = reporter.render(error, host);
  if (rendered instanceof Response) return rendered;
  if (rendered) return c.json(rendered.body, rendered.status as ContentfulStatusCode);
  if (error instanceof HTTPException && error.status < 500 && error.res) {
    return error.getResponse();
  }
  const { body, status } = renderHttpError(error, {
    catalog: reporter.catalog,
    redactServerBodies,
  });
  return c.json(body, status as ContentfulStatusCode);
}

// `{ status, body }` with nothing else: a filter's explicit response.
function isExplicitResult(value: unknown): value is { status: StatusCode; body: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    'status' in value &&
    'body' in value &&
    typeof value.status === 'number' &&
    Number.isInteger(value.status)
  );
}

/**
 * The response for an exception filter's result. `undefined` means the filter
 * did not handle the error, so the default renderer runs. A `Response` passes
 * through; `{ status, body }` sets the status explicitly; any other value is
 * the body, sent with the exception's status (`getErrorStatus`).
 */
export function mapFilterResult(c: Context, result: unknown, error: unknown): Response | undefined {
  if (result === undefined) return undefined;
  if (result instanceof Response) return result;
  if (isExplicitResult(result)) return mapResponse(c, result.body, result.status);
  return mapResponse(c, result, getErrorStatus(error) as StatusCode);
}
