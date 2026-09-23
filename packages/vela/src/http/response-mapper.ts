import type { Context } from 'hono';
import type { RedirectStatusCode, StatusCode } from 'hono/utils/http-status';
import { getEndpointDefinition } from '../openapi/endpoint';
import type { Constructor } from '../registry/types';
import { getHttpCode } from './decorators';

/** The status of a successful non-empty result from a handler that declares none. */
export const DEFAULT_SUCCESS_STATUS = 200;

/**
 * The success status a handler declares: its `@Endpoint` contract, then `@HttpCode`.
 * `undefined` leaves the default, which is 200 (204 for an empty result). Responses,
 * OpenAPI and the response cache all read the status from here.
 */
export function resolveSuccessStatus(
  controller: Constructor,
  handler: string | symbol,
): StatusCode | undefined {
  return getEndpointDefinition(controller, handler)?.status ?? getHttpCode(controller, handler);
}

interface RedirectOverride {
  url: string;
  statusCode?: RedirectStatusCode;
}

export interface ResponseRedirect {
  url: string;
  statusCode: RedirectStatusCode;
}

// Hono's redirect union is the integer range 300–308, including deprecated
// codes. Dynamic handler results must satisfy that same runtime contract.
function isRedirectStatus(status: unknown): status is RedirectStatusCode {
  return typeof status === 'number' && Number.isInteger(status) && status >= 300 && status <= 308;
}

// A handler returning `{ url, statusCode? }` may override the @Redirect-decorator
// destination — kept identical to the previous inline behavior.
function parseRedirectResult(result: unknown): RedirectOverride | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  if (!('url' in result)) return undefined;

  if (typeof result.url !== 'string') return undefined;
  const status = 'statusCode' in result ? result.statusCode : undefined;
  if (status !== undefined && !isRedirectStatus(status)) {
    throw new RangeError('Redirect statusCode must be an integer from 300 to 308.');
  }

  return {
    url: result.url,
    statusCode: status,
  };
}

// Maps a controller return value to a Hono Response. `null`/`undefined` → 204
// (empty body); strings → text; anything else → JSON. A pre-built Response
// passes through unchanged.
export function mapResponse(c: Context, result: unknown, statusCode?: StatusCode): Response {
  if (result instanceof Response) {
    return result;
  }
  const status =
    statusCode ?? (result === null || result === undefined ? 204 : DEFAULT_SUCCESS_STATUS);
  // Ordinary Fetch responses cannot carry informational/upgrade statuses.
  // A transport-owned upgrade Response passed through above stays untouched.
  if (status === 101) {
    throw new RangeError('HTTP upgrades must return a transport-created Response.');
  }
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError('HTTP response status must be an integer from 200 to 599.');
  }
  if (
    result === null ||
    result === undefined ||
    status === 204 ||
    status === 205 ||
    status === 304
  ) {
    return c.body(null, status);
  }
  if (typeof result === 'string') {
    return c.text(result, status);
  }
  return c.json(result, status);
}

// Honors @Redirect on the handler. If the handler returned `{ url, statusCode? }`,
// those override the decorator's defaults; otherwise the decorator wins.
export function mapRedirect(c: Context, result: unknown, redirect: ResponseRedirect): Response {
  const overrides = parseRedirectResult(result);
  const finalUrl = overrides?.url ?? redirect.url;
  const finalStatus = overrides?.statusCode ?? redirect.statusCode;
  if (!isRedirectStatus(finalStatus)) {
    throw new RangeError('Redirect statusCode must be an integer from 300 to 308.');
  }
  return c.redirect(finalUrl, finalStatus);
}

export function applyResponseHeaders(
  response: Response,
  headers: Iterable<readonly [string, string]>,
): void {
  for (const [name, value] of headers) {
    response.headers.set(name, value);
  }
}
