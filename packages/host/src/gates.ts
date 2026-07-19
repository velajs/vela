/**
 * The loopback dev host's security gates. The host serves developer-only admin
 * tooling and its proxy injects the master admin token server-side, so every
 * request is confined to a same-origin loopback browser. These gates return a
 * refusal reason (→ the caller answers 403) or `undefined` when the request may
 * proceed.
 */
import { FORWARDING_HEADERS, LOOPBACK_HOSTS } from './constants';

/**
 * True for an IPv4/IPv6 loopback peer (`127.0.0.0/8`, `::1`, the fully-expanded
 * `0:0:0:0:0:0:0:1`, and the IPv4-mapped `::ffff:127.x`). A missing address
 * means the transport can't be read (a mocked/in-process request) — treated as
 * loopback so a mounting adapter's own bind stays the source of truth there.
 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined || remoteAddress === '') {
    return true;
  }
  const address = remoteAddress.toLowerCase();
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (v4 === '::1' || v4 === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return v4.startsWith('127.');
}

/**
 * True only for a CONCRETELY-verified loopback peer: the kernel reported a
 * non-empty address and it is loopback. Distinct from {@link isLoopbackAddress},
 * which also returns `true` for a missing/unverifiable address — a distinction
 * the DNS-rebind gate relies on to fail closed when it can't prove locality.
 */
function isConcreteLoopbackPeer(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && remoteAddress !== '' && isLoopbackAddress(remoteAddress);
}

/** The host portion (no port) of a `Host` header value, lower-cased; brackets stripped from IPv6. */
export function hostnameOf(host: string | undefined): string | undefined {
  if (host === undefined) {
    return undefined;
  }
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close === -1 ? value.slice(1) : value.slice(1, close);
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * Transport gate applied to EVERY request. Reads the actual socket peer and the
 * `Host` header:
 *  - reject a non-loopback peer (catches a non-loopback bind),
 *  - reject a non-localhost `Host` (catches DNS rebinding — a public name that
 *    resolves to loopback still arrives with that name in `Host`),
 *  - reject a MISSING `Host` — fail closed (see below),
 *  - reject any `X-Forwarded-*` / `Forwarded` header (a reverse proxy/tunnel is
 *    relaying a possibly-remote client that must never drive the proxy).
 * Returns a refusal reason, or `undefined` when the connection is loopback-local.
 *
 * Missing-Host policy: a browser ALWAYS sends `Host`, so its absence means a
 * non-browser client. Rather than silently skip the DNS-rebind check (which
 * would let a public mount bypass it by simply omitting `Host`), we fail closed
 * — EXCEPT when the kernel-reported peer is a concretely-verified loopback IP
 * (a trusted local CLI such as `curl`). An unverifiable/in-process peer with no
 * `Host` is rejected: locality could not be proven from either signal.
 */
export function transportRejectionReason(input: {
  remoteAddress?: string;
  headers: Headers;
}): string | undefined {
  if (!isLoopbackAddress(input.remoteAddress)) {
    return 'Vela Studio is only available on loopback connections.';
  }

  const host = hostnameOf(input.headers.get('host') ?? undefined);
  if (host === undefined) {
    if (!isConcreteLoopbackPeer(input.remoteAddress)) {
      return 'Vela Studio rejects a request with no Host header.';
    }
  } else if (!LOOPBACK_HOSTS.has(host)) {
    return 'Vela Studio rejects a non-localhost Host header.';
  }

  if (FORWARDING_HEADERS.some((name) => input.headers.has(name))) {
    return 'Vela Studio refuses a proxied (X-Forwarded-*) request.';
  }

  return undefined;
}

/**
 * Origin layer of the CSRF gate: prefer the unforgeable `Sec-Fetch-Site` header,
 * else compare the `Origin` host against the request `Host`. Returns a refusal
 * reason or `undefined` when the origin is acceptable.
 */
function originRejectionReason(headers: Headers): string | undefined {
  const secFetchSite = headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite !== undefined && secFetchSite !== '') {
    return secFetchSite === 'same-origin' || secFetchSite === 'same-site' || secFetchSite === 'none'
      ? undefined
      : 'cross-origin request rejected';
  }

  const origin = headers.get('origin')?.trim().toLowerCase();
  if (origin === undefined || origin === '' || origin === 'null') {
    return undefined;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return 'invalid origin header';
  }

  const host = headers.get('host')?.trim().toLowerCase();
  return host === undefined || originHost !== host ? 'cross-origin request rejected' : undefined;
}

/**
 * Application-level CSRF defense for the token-injecting proxy. The loopback
 * bind alone does NOT stop a cross-site page in the developer's own browser from
 * POSTing a CORS "simple request" whose side effects run before the browser
 * blocks the response read. Two layers, both must pass:
 *  1. Origin (via {@link originRejectionReason}).
 *  2. Content-Type: a state-changing request must be `application/json`, which a
 *     cross-origin `fetch` can't set without a (then-blocked) preflight.
 * Safe methods (GET/HEAD) skip the content-type check. Returns a refusal reason
 * or `undefined`.
 */
export function csrfRejectionReason(input: {
  method: string;
  headers: Headers;
}): string | undefined {
  const originReason = originRejectionReason(input.headers);
  if (originReason !== undefined) {
    return originReason;
  }

  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const contentType = input.headers.get('content-type')?.trim().toLowerCase();
    if (contentType === undefined || !contentType.startsWith('application/json')) {
      return 'content-type must be application/json';
    }
  }

  return undefined;
}
