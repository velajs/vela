/**
 * The token-injection proxy — the security crux of the host.
 *
 * The browser talks ONLY to the loopback host and never holds the master admin
 * token. When forwarding an admin request to the app origin, the host adds
 * `Authorization: Bearer <masterToken>` SERVER-SIDE, replacing whatever the
 * browser sent. The master token lives only in this process.
 *
 * Request and response bodies are streamed (never buffered), so large exports /
 * uploads pass straight through.
 */
import { HOP_BY_HOP_HEADERS } from './constants';

/** `RequestInit` extended with undici's `duplex`, required for a streamed body. */
interface StreamingRequestInit extends RequestInit {
  duplex?: 'half';
}

export interface ProxyOptions {
  /** Origin of the running Vela app (e.g. `http://127.0.0.1:8787`). */
  readonly workerOrigin: string;
  /** The MASTER admin token, injected as `Authorization: Bearer` server-side. */
  readonly adminToken?: string;
  /** `fetch` used to reach the app (injected in tests); defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/** Copy request headers, dropping hop-by-hop + `host`, and overwriting `authorization`. */
function buildForwardHeaders(source: Headers, adminToken: string | undefined): Headers {
  const headers = new Headers();
  for (const [key, value] of source) {
    const name = key.toLowerCase();
    // `host` is set by fetch from the target URL; hop-by-hop headers describe
    // the browser↔host hop only. The client's `authorization` is discarded — the
    // master token is added below, never trusted from the browser.
    if (name === 'host' || name === 'authorization' || HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }
    headers.append(key, value);
  }
  if (adminToken !== undefined && adminToken !== '') {
    headers.set('authorization', `Bearer ${adminToken}`);
  }
  return headers;
}

/** Copy response headers, dropping hop-by-hop + content framing that streaming re-derives. */
function buildResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of source) {
    const name = key.toLowerCase();
    // `content-encoding`/`content-length` describe the upstream (already-decoded
    // by fetch) body; forwarding them over a re-chunked stream corrupts it.
    if (HOP_BY_HOP_HEADERS.has(name) || name === 'content-encoding' || name === 'content-length') {
      continue;
    }
    headers.append(key, value);
  }
  return headers;
}

/**
 * Forward `request` (already gate-checked) to the app origin at the same path +
 * query, injecting the master bearer server-side, and return the app's streamed
 * response. On a transport failure the app is unreachable → 502.
 */
export async function proxyToWorker(request: Request, options: ProxyOptions): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, options.workerOrigin);

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const init: StreamingRequestInit = {
    method,
    headers: buildForwardHeaders(request.headers, options.adminToken),
    redirect: 'manual',
  };
  if (hasBody && request.body !== null) {
    init.body = request.body;
    init.duplex = 'half';
  }

  const doFetch = options.fetchImpl ?? fetch;

  let upstream: Response;
  try {
    upstream = await doFetch(target, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ ok: false, error: `Studio host could not reach the app: ${message}` }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildResponseHeaders(upstream.headers),
  });
}
