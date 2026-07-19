/**
 * {@link studioMiddleware} — the same serving + token-injecting proxy core as
 * {@link startStudioServer}, shaped as a Hono middleware so a future adapter can
 * mount the host in-process. It is typed structurally (no `hono` dependency —
 * the host stays standalone): any context exposing `req.raw` (a web `Request`)
 * satisfies it.
 *
 * The CLI uses {@link startStudioServer}, which enforces the full loopback-peer
 * gate from the real socket. In middleware mode the peer address isn't known
 * from the web `Request` alone, so the mounting adapter is responsible for
 * binding loopback; the Host / X-Forwarded / CSRF gates and the server-side
 * bearer injection still apply here. Pass `getRemoteAddress` to restore the peer
 * gate when the adapter can supply the socket address.
 */
import { createStudioHandler } from './handler';
import { resolveOptions } from './options';
import type { StudioHostOptions } from './types';

/** The minimal Hono context surface the middleware reads. */
export interface StudioMiddlewareContext {
  readonly req: { readonly raw: Request };
}

/** A Hono-style middleware: return a `Response` to answer, or `await next()` to pass through. */
export type StudioMiddleware = (
  c: StudioMiddlewareContext,
  next: () => Promise<void>,
) => Promise<Response | undefined>;

export interface StudioMiddlewareOptions extends StudioHostOptions {
  /** Resolve the socket peer address from the context, to enforce the loopback-peer gate. */
  getRemoteAddress?: (c: StudioMiddlewareContext) => string | undefined;
}

export function studioMiddleware(options: StudioMiddlewareOptions): StudioMiddleware {
  const resolved = resolveOptions(options);
  const handle = createStudioHandler(resolved);
  const getRemoteAddress = options.getRemoteAddress;

  return async (c, next): Promise<Response | undefined> => {
    const remoteAddress = getRemoteAddress?.(c);
    const response = await handle(c.req.raw, remoteAddress);
    if (response !== undefined) {
      return response;
    }
    await next();
    return undefined;
  };
}
