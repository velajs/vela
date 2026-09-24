import {
  CORE_CATALOG,
  codeForStatus,
  isVelaError,
  toErrorBody,
  VelaError,
  type Catalog,
} from '@velajs/errors';
import { HTTPException } from 'hono/http-exception';
import { HttpException, type HttpErrorResponse } from '../errors/http-exception';

/** The status and JSON body an error renders as on an HTTP edge. */
export interface RenderedHttpError {
  readonly status: number;
  readonly body: unknown;
  /** The error's own text was withheld from `body`; report the raw error server-side. */
  readonly redacted: boolean;
}

export interface RenderHttpErrorOptions {
  /** Catalog for branded errors. Defaults to the core catalog. */
  catalog?: Catalog<string>;
  /**
   * Redact an exception-owned 5xx body (`toResponse()`) to its status title.
   * Controller handlers and Vela middleware send it, since it is deliberate
   * (a health check's 503). The raw Hono `onError` edge, which only sees
   * unplanned throws, and transports that cannot carry the body redact it.
   */
  redactServerBodies?: boolean;
}

/**
 * The status of a caught error: `HttpException.getStatus()`, a branded
 * `VelaError`'s `status`, Hono's `HTTPException.status`, else 500.
 */
export function getErrorStatus(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  if (isVelaError(error)) return error.status;
  if (error instanceof HTTPException) return error.status;
  return 500;
}

// An error's own `toResponse()`: a 400–599 status and a JSON body. A missing,
// invalid or throwing hook falls back to the canonical body.
function ownedResponse(error: unknown): HttpErrorResponse | undefined {
  if (typeof error !== 'object' || error === null || !('toResponse' in error)) return undefined;
  const hook = error.toResponse;
  if (typeof hook !== 'function') return undefined;
  let owned: unknown;
  try {
    owned = Reflect.apply(hook, error, []);
  } catch {
    return undefined;
  }
  if (
    typeof owned !== 'object' ||
    owned === null ||
    !('status' in owned) ||
    !('body' in owned) ||
    typeof owned.status !== 'number' ||
    !Number.isInteger(owned.status) ||
    owned.status < 400 ||
    owned.status > 599
  )
    return undefined;
  return { status: owned.status, body: owned.body };
}

/**
 * The one HTTP error renderer. Every edge — controller handlers, Vela
 * middleware, the unmatched-route 404, request limits, the raw Hono
 * `onError`, RPC and GraphQL — derives its status and body here:
 *
 * 1. An exception-owned `toResponse()` (an object `HttpException` renders
 *    verbatim; `@velajs/crud` renders its envelope), unless it is a 5xx and
 *    `redactServerBodies` is set.
 * 2. `HttpException`: `{ error: { code, message, details? } }`. Only a 4xx
 *    echoes its text and details; any other status is redacted to its title.
 * 3. Hono's `HTTPException`: its message below 500, redacted from 500.
 * 4. Anything else through `toErrorBody`: branded `VelaError`s render their
 *    code, message and data; unbranded and internal errors are redacted.
 *
 * The application's `ExceptionHandler.render` hook runs before this.
 */
export function renderHttpError(
  error: unknown,
  options: RenderHttpErrorOptions = {},
): RenderedHttpError {
  const catalog = options.catalog ?? CORE_CATALOG;
  const owned = ownedResponse(error);
  if (owned) {
    if (!options.redactServerBodies || owned.status < 500) {
      return { status: owned.status, body: owned.body, redacted: false };
    }
    return toErrorBody(error, { catalog, fallbackStatus: owned.status });
  }
  if (error instanceof HTTPException) {
    return error.status < 500
      ? toErrorBody(
          new VelaError(codeForStatus(error.status), {
            message: error.message,
            status: error.status,
          }),
          { catalog },
        )
      : {
          status: error.status,
          body: { error: { code: 'internal', message: 'Internal Server Error' } },
          redacted: true,
        };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    // Only a client fault's text and details are meant for the caller.
    if (status < 400 || status >= 500)
      return toErrorBody(error, { catalog, fallbackStatus: status });
    const details = error.getDetails();
    return toErrorBody(
      new VelaError(codeForStatus(status), {
        message: error.message,
        status,
        ...(details === undefined ? {} : { data: details }),
      }),
      { catalog },
    );
  }
  return toErrorBody(error, { catalog });
}
