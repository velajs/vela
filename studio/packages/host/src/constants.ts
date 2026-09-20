/**
 * Shared constants for the loopback dev host. Kept dependency-free (no
 * `@velajs/studio-protocol` edge) so the host stays standalone — the default
 * admin mount path mirrors the protocol's `STUDIO_DEFAULT_PATH` by value.
 */

/**
 * Default server admin-mount prefix the host proxies to the app. Mirrors
 * `@velajs/studio-protocol`'s `STUDIO_DEFAULT_PATH` — the same prefix the
 * browser {@link https://github.com/velajs/studio AdminClient} targets, so a
 * request to `${adminPath}/rpc/<op>` on the loopback host reaches the app's
 * admin surface unchanged.
 */
export const DEFAULT_ADMIN_PATH = '/_vela/admin';

/** Default SPA router base path — the host serves a dedicated Studio at root. */
export const DEFAULT_BASE_PATH = '/';

/** Loopback interface the host binds to; the peer gate double-checks it. */
export const DEFAULT_HOST = '127.0.0.1';

/** Built asset filenames the standalone browser bundle emits + the host serves. */
export const STANDALONE_SCRIPT = 'studio.js';
export const STANDALONE_STYLE = 'styles.css';

/** Host names the `Host` header may carry on a loopback dev host (DNS-rebind gate). */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  // Fully-expanded IPv6 loopback — the same address as `::1`, spelled out. A
  // client that emits this form must not be falsely flagged as DNS rebinding.
  '0:0:0:0:0:0:0:1',
  'localhost',
]);

/**
 * Request headers that betray a reverse proxy / tunnel in front of the host. A
 * direct loopback browser never sets these; their presence means a (possibly
 * remote) client is being relayed and must not drive the token-injecting proxy.
 */
export const FORWARDING_HEADERS: readonly string[] = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
];

/**
 * Hop-by-hop headers (RFC 7230 §6.1) stripped from both the forwarded request
 * and the returned response — they describe a single transport hop, not the
 * end-to-end message.
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
