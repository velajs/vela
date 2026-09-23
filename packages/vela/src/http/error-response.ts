import { STATUS_TO_CODE, toErrorBody, type Catalog, type ErrorBodyResult } from '@velajs/errors';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Container } from '../container/container';
import { HttpException } from '../errors/http-exception';
import type { ErrorReporter } from '../exceptions/reporter';
import { ERROR_CATALOG } from '../pipeline/tokens';
import type { ExecutionContext } from '../pipeline/types';

/** Options for {@link toHttpErrorBody}. */
export interface HttpErrorBodyOptions {
  /** Catalog for branded errors; takes precedence over `context`. */
  catalog?: Catalog<string>;
  /**
   * The context passed to `ExceptionHandler.render`. Its container supplies the
   * application's composed catalog (`ErrorsModule`), so the result redacts
   * exactly like the default renderer. Without either option, the core catalog
   * applies.
   */
  context?: unknown;
}

// The composed catalog registered for the application, read from a render
// hook's execution context.
function contextCatalog(context: unknown): Catalog<string> | undefined {
  if (
    context === null ||
    typeof context !== 'object' ||
    !('getContainer' in context) ||
    typeof context.getContainer !== 'function'
  )
    return undefined;
  const container: unknown = context.getContainer();
  return container instanceof Container && container.has(ERROR_CATALOG)
    ? container.resolve(ERROR_CATALOG)
    : undefined;
}

// An HttpException built with an object, or a Hono HTTPException below 500,
// carries an author-intended response that is sent as-is.
function carriesOwnResponse(error: unknown): boolean {
  return (
    (error instanceof HttpException && typeof error.getRawResponse() !== 'string') ||
    (error instanceof HTTPException && error.status < 500)
  );
}

function canonicalBody(error: unknown, catalog: Catalog<string> | undefined): ErrorBodyResult {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const raw = error.getRawResponse();
    const details = error.getDetails();
    return {
      body: {
        error: {
          code: STATUS_TO_CODE[status] ?? 'internal',
          message: typeof raw === 'string' ? raw : error.message,
          ...(details === undefined ? {} : { details }),
        },
      },
      status,
      redacted: false,
    };
  }
  if (error instanceof HTTPException) {
    // A 5xx Hono exception may carry provider-controlled text; keep only its status.
    return {
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
      status: error.status,
      redacted: true,
    };
  }
  return toErrorBody(error, { catalog });
}

/**
 * The default JSON body Vela sends for an HTTP failure:
 * `{ error: { code, message, details? } }`.
 *
 * - `HttpException` with a string message: the status's core catalog code
 *   (`internal` when the status has none), the message, and `details` when set.
 * - `VelaError` and any other error: {@link toErrorBody}, which redacts
 *   unbranded and internal errors.
 * - Hono `HTTPException` of 500 or above: a redacted `internal` body.
 *
 * Returns `undefined` when the error carries its own response: an
 * `HttpException` constructed with an object (sent verbatim) or a Hono
 * `HTTPException` below 500. Custom `ExceptionHandler.render` hooks can build
 * on this result, for example to translate `error.message` by `error.code`;
 * pass the hook's `context` so application catalog codes redact as usual.
 */
export function toHttpErrorBody(
  error: unknown,
  options: HttpErrorBodyOptions = {},
): ErrorBodyResult | undefined {
  if (carriesOwnResponse(error)) return undefined;
  return canonicalBody(error, options.catalog ?? contextCatalog(options.context));
}

/**
 * The single HTTP error rendering path shared by controller handlers,
 * middleware (including the framework's request limits), unmatched routes, and
 * the application's last-resort error handler: the application's
 * `ExceptionHandler.render` hook first, then the default body.
 */
export function renderHttpError(
  c: Context,
  error: unknown,
  reporter: ErrorReporter,
  context: ExecutionContext,
): Response {
  const rendered = reporter.render(error, context);
  if (rendered instanceof Response) return rendered;
  if (rendered) return c.json(rendered.body, rendered.status as ContentfulStatusCode);
  if (error instanceof HTTPException && error.status < 500) return error.getResponse();
  if (error instanceof HttpException) {
    const raw = error.getRawResponse();
    // Object responses ship verbatim (crud envelope compat).
    if (typeof raw !== 'string') return c.json(raw, error.getStatus() as ContentfulStatusCode);
  }
  const { body, status } = canonicalBody(error, reporter.catalog);
  return c.json(body, status as ContentfulStatusCode);
}
