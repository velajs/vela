/**
 * {@link studioMiddleware} — the same serving + token-injecting proxy core as
 * {@link startStudioServer}, shaped as a Hono middleware so a future adapter can
 * mount the host in-process. It is typed structurally (no `hono` dependency —
 * the host stays standalone): any context exposing `req.raw` (a web `Request`)
 * satisfies it.
 *
 * The CLI uses {@link startStudioServer}, which enforces the full loopback-peer
 * gate from the real socket. In middleware mode the peer address isn't known
 * from the web `Request` alone — so the middleware FAILS CLOSED: it refuses
 * every request with `403` unless the caller either
 *  - supplies {@link StudioMiddlewareOptions.getRemoteAddress} (the peer gate is
 *    then enforced against the real socket address), or
 *  - sets {@link StudioMiddlewareOptions.loopbackOnly | loopbackOnly: false} to
 *    explicitly delegate the loopback trust boundary to the mounting adapter.
 *
 * Without one of those, a public mount that forgot to bind loopback would let a
 * remote request pass every gate (a missing peer reads as loopback) and receive
 * the master admin token — so the middleware declines to run at all. The Host /
 * X-Forwarded / CSRF gates and the server-side bearer injection still apply on
 * top once the request is admitted.
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
  /**
   * Loopback enforcement contract. Defaults to `true`: the middleware then
   * REQUIRES {@link getRemoteAddress} to verify the socket peer and FAILS CLOSED
   * (`403`, peer unverifiable) when none is supplied — otherwise a public mount
   * that omitted a loopback bind would forward the master token to a remote
   * client. Set `false` to explicitly delegate the loopback trust boundary to
   * the mounting adapter (which guarantees a loopback bind by other means); the
   * caller then OWNS the trust boundary and the peer check is waived.
   */
  loopbackOnly?: boolean;
}

const peerUnverifiableResponse = (): Response =>
  new Response(
    'Vela Studio middleware cannot verify the socket peer is loopback: pass getRemoteAddress, or set loopbackOnly:false to delegate the loopback trust boundary to the mounting adapter.',
    { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );

export function studioMiddleware(options: StudioMiddlewareOptions): StudioMiddleware {
  const resolved = resolveOptions(options);
  const handle = createStudioHandler(resolved);
  const getRemoteAddress = options.getRemoteAddress;
  // Fail closed: with neither a peer resolver nor an explicit opt-out, the socket
  // peer can't be proven loopback, so the middleware refuses to run — the handler
  // (and therefore the master-token-injecting proxy) is never reached.
  const peerUnverifiable = getRemoteAddress === undefined && options.loopbackOnly !== false;

  return async (c, next): Promise<Response | undefined> => {
    if (peerUnverifiable) {
      return peerUnverifiableResponse();
    }
    const remoteAddress = getRemoteAddress?.(c);
    const response = await handle(c.req.raw, remoteAddress);
    if (response !== undefined) {
      return response;
    }
    await next();
    return undefined;
  };
}
