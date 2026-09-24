import type { Context } from 'hono';
import type { RedirectStatusCode, StatusCode } from 'hono/utils/http-status';
import type { Constructor } from '../registry/types';
import { getHttpCode } from './decorators';
import { defaultRouteStatus, type RouteContractMetadata } from './route-contract';

/**
 * The success status a route sends: `@HttpCode`, else its declared `status`,
 * else 204 for `response: null`, 201 for POST and 200 for every other method —
 * whatever the handler returns. Responses and OpenAPI read each route's status
 * from here; the response cache reads the executing route's.
 */
export function resolveSuccessStatus(
  controller: Constructor,
  route: {
    readonly handlerName: string | symbol;
    readonly method: string;
    readonly contract?: RouteContractMetadata;
  },
): StatusCode {
  return (
    getHttpCode(controller, route.handlerName) ?? defaultRouteStatus(route.method, route.contract)
  );
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

// Maps a controller return value to a Hono Response at the route's status:
// `null`/`undefined` → empty body; strings → text; anything else → JSON. A
// pre-built Response passes through unchanged.
export function mapResponse(c: Context, result: unknown, status: StatusCode): Response {
  if (result instanceof Response) {
    return result;
  }
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
