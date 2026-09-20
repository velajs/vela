import { STUDIO_PROTOCOL_VERSION } from '@velajs/studio-protocol';
import { executeApiRequest } from './try-it';
/**
 * The transport-agnostic request core shared by {@link startStudioServer} (a
 * `node:http` server) and {@link studioMiddleware} (a Hono middleware). It takes
 * a web `Request` + the socket peer address and returns a web `Response`:
 *
 *  1. Every request passes the transport gate (loopback peer / Host / X-Forwarded).
 *  2. `{adminPath}/*` → CSRF gate, then the token-injecting proxy.
 *  3. A `.js` / `.js.map` / `.css` under the base path → a standalone asset.
 *  4. Anything else under the base path → the SPA document (or the build hint).
 *  5. Anything outside the base path → `undefined` (middleware passes to `next`;
 *     the standalone server answers 404).
 */
import {
  assetContentType,
  isStandaloneModulePath,
  loadStudioAssets,
  readStandaloneAsset,
  studioAssetsStamp,
} from './assets';
import { STANDALONE_STYLE } from './constants';
import { csrfRejectionReason, transportRejectionReason } from './gates';
import { joinBase } from './options';
import type { ResolvedOptions } from './options';
import { proxyToWorker } from './proxy';
import { renderMissingAssetsHtml, renderStudioHtml } from './render-html';
import type { StudioAssets } from './types';

const textResponse = (status: number, body: string, contentType: string): Response =>
  new Response(body, { status, headers: { 'content-type': contentType } });

const forbidden = (reason: string): Response =>
  textResponse(403, reason, 'text/plain; charset=utf-8');

/** The handler is a closure over per-server state (session token + asset cache). */
export type StudioRequestHandler = (
  request: Request,
  remoteAddress: string | undefined,
) => Promise<Response | undefined>;

export function createStudioHandler(resolved: ResolvedOptions): StudioRequestHandler {
  const scriptSrc = joinBase(resolved.basePath, 'studio.js');
  const styleHref = joinBase(resolved.basePath, STANDALONE_STYLE);

  // Cache the resolved assets for the session but re-check the mtime stamp per
  // request, so a `@velajs/studio-ui` rebuild mid-session is picked up live.
  let assets: StudioAssets | undefined;
  let assetsStamp: number | undefined;
  let assetsLoaded = false;
  let cachedHtml: string | undefined;

  const refreshAssets = (): StudioAssets | undefined => {
    const stamp = studioAssetsStamp(resolved.resolveFrom);
    if (!assetsLoaded || stamp !== assetsStamp) {
      assets = loadStudioAssets(resolved.logger, resolved.resolveFrom);
      assetsStamp = stamp;
      assetsLoaded = true;
      // Any rebuild (new chunk names) invalidates the cached document.
      cachedHtml = undefined;
    }
    return assets;
  };

  const documentResponse = (): Response => {
    const current = refreshAssets();
    if (current === undefined) {
      return textResponse(503, renderMissingAssetsHtml(), 'text/html; charset=utf-8');
    }
    cachedHtml ??= renderStudioHtml({
      connection: {
        protocolVersion: STUDIO_PROTOCOL_VERSION,
        routerBasePath: resolved.basePath || '/',
        adminBasePath: resolved.adminPath,
        apiRequestPath: `${resolved.adminPath}/api-request`,
        sessionToken: resolved.sessionToken,
      },
      scriptSrc,
      styleHref,
    });
    const response = textResponse(200, cachedHtml, 'text/html; charset=utf-8');
    response.headers.set('cache-control', 'no-store');
    return response;
  };

  const assetResponse = (fileName: string): Response => {
    if (refreshAssets() === undefined) {
      return textResponse(
        503,
        'Vela Studio assets not built — run: pnpm --filter @velajs/studio-ui build',
        'text/plain; charset=utf-8',
      );
    }
    const bytes = readStandaloneAsset(fileName, resolved.resolveFrom);
    if (bytes === undefined) {
      return textResponse(404, 'Not found', 'text/plain; charset=utf-8');
    }
    const body = new Uint8Array(bytes);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': assetContentType(fileName), 'cache-control': 'no-cache' },
    });
  };

  const isUnderAdminPath = (pathname: string): boolean =>
    pathname === resolved.adminPath || pathname.startsWith(`${resolved.adminPath}/`);

  const isUnderBasePath = (pathname: string): boolean => {
    if (resolved.basePath === '') {
      return true;
    }
    return pathname === resolved.basePath || pathname.startsWith(`${resolved.basePath}/`);
  };

  return async (request, remoteAddress): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Transport gate — applies to every request the host owns.
    const transportReason = transportRejectionReason({ remoteAddress, headers: request.headers });
    if (transportReason !== undefined) {
      return forbidden(transportReason);
    }

    // 2. Admin proxy — CSRF-gated, then bearer-injected + streamed to the app.
    if (isUnderAdminPath(pathname)) {
      const csrfReason = csrfRejectionReason({ method: request.method, headers: request.headers });
      if (csrfReason !== undefined) {
        return textResponse(
          403,
          JSON.stringify({ ok: false, error: csrfReason }),
          'application/json; charset=utf-8',
        );
      }
      if (request.headers.get('authorization') !== `Bearer ${resolved.sessionToken}`) {
        return forbidden('Invalid Studio host session. Reload Studio to reconnect.');
      }
      if (pathname === `${resolved.adminPath}/api-request`) {
        return executeApiRequest(request, resolved);
      }
      return proxyToWorker(request, {
        workerOrigin: resolved.workerOrigin,
        adminToken: resolved.adminToken,
        fetchImpl: resolved.fetchImpl,
      });
    }

    // Outside the SPA mount: not ours (middleware → next; server → 404).
    if (!isUnderBasePath(pathname)) {
      return undefined;
    }

    // 3. Static asset (the bundle entry, a code-split chunk, or the stylesheet).
    const fileName = pathname.slice(pathname.lastIndexOf('/') + 1);
    if (isStandaloneModulePath(pathname) || fileName === STANDALONE_STYLE) {
      return assetResponse(fileName);
    }

    // 4. SPA document fallback (deep links boot the router there).
    return documentResponse();
  };
}
