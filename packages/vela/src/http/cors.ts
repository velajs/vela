import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

/**
 * Cross-origin resource sharing for an application, as Nest's
 * `app.enableCors(options)` and `VelaFactory.create(root, { cors })` take it.
 * Served by Hono's `cors` middleware ahead of every route, guard and body read.
 */
export interface CorsOptions {
  /**
   * Allowed origins: one origin, a list, or a function returning the origin to
   * allow (or nothing to refuse). Default `'*'`, which cannot be credentialed.
   */
  origin?: string | string[] | ((origin: string) => string | undefined | null);
  /** Methods a preflight allows. Default, as in Nest: GET, HEAD, PUT, PATCH, POST, DELETE. */
  allowMethods?: string[];
  /** Request headers a preflight allows. Default: the requested headers. */
  allowHeaders?: string[];
  /** Response headers browsers may read. */
  exposeHeaders?: string[];
  /** Emit `Access-Control-Allow-Credentials: true`; needs explicit origins. */
  credentials?: boolean;
  /** Preflight cache lifetime in seconds. */
  maxAge?: number;
}

// Nest's `enableCors()` default, stated here rather than taken from Hono,
// whose own default list differs between versions.
const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

/** Validate CORS options and build the middleware that serves them. */
export function corsMiddleware(options: CorsOptions): MiddlewareHandler {
  const origin = options.origin ?? '*';
  if (
    options.credentials === true &&
    (origin === '*' || (Array.isArray(origin) && origin.includes('*')))
  ) {
    throw new TypeError(
      "CORS credentials need explicit origins: browsers refuse a credentialed '*' origin.",
    );
  }
  if (
    options.maxAge !== undefined &&
    (!Number.isSafeInteger(options.maxAge) || options.maxAge < 0)
  ) {
    throw new TypeError('CORS maxAge must be a non-negative integer of seconds.');
  }
  return cors({
    origin: typeof origin === 'function' ? (value) => origin(value) : origin,
    // Hono spreads these over its defaults, so an undefined key would erase one.
    allowMethods: options.allowMethods ?? DEFAULT_METHODS,
    allowHeaders: options.allowHeaders,
    exposeHeaders: options.exposeHeaders,
    credentials: options.credentials,
    maxAge: options.maxAge,
  });
}
