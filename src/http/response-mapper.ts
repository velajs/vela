import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

interface RedirectOverride {
  url: string;
  statusCode?: number;
}

export interface ResponseRedirect {
  url: string;
  statusCode: number;
}

// A handler returning `{ url, statusCode? }` may override the @Redirect-decorator
// destination — kept identical to the previous inline behavior.
function parseRedirectResult(result: unknown): RedirectOverride | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  if (!('url' in result)) return undefined;

  const obj = result as { url: unknown; statusCode?: unknown };
  if (typeof obj.url !== 'string') return undefined;

  return {
    url: obj.url,
    ...(typeof obj.statusCode === 'number' ? { statusCode: obj.statusCode } : {}),
  };
}

// Maps a controller return value to a Hono Response. `null`/`undefined` → 204
// (empty body); strings → text; anything else → JSON. A pre-built Response
// passes through unchanged.
export function mapResponse(c: Context, result: unknown, statusCode?: number): Response {
  if (result instanceof Response) {
    return result;
  }
  if (result === null || result === undefined) {
    return c.body(null, (statusCode ?? 204) as ContentfulStatusCode);
  }
  if (typeof result === 'string') {
    return c.text(result, (statusCode ?? 200) as ContentfulStatusCode);
  }
  return c.json(result as object, (statusCode ?? 200) as ContentfulStatusCode);
}

// Honors @Redirect on the handler. If the handler returned `{ url, statusCode? }`,
// those override the decorator's defaults; otherwise the decorator wins.
export function mapRedirect(c: Context, result: unknown, redirect: ResponseRedirect): Response {
  const overrides = parseRedirectResult(result);
  const finalUrl = overrides?.url ?? redirect.url;
  const finalStatus = overrides?.statusCode ?? redirect.statusCode;
  return c.redirect(finalUrl, finalStatus as 301 | 302 | 303 | 307 | 308);
}

export function applyResponseHeaders(
  response: Response,
  headers: Iterable<readonly [string, string]>,
): void {
  for (const [name, value] of headers) {
    response.headers.set(name, value);
  }
}
