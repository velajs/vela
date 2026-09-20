// The better-auth session cookie name; the plugin may prefix it (e.g.
// `better-auth.session_token`, or `__Secure-better-auth.session_token` under
// secure cookies). Kept as a plain string and matched by split/`indexOf` — no
// regex, so there is no backtracking surface on attacker-influenced cookie text.
const SESSION_TOKEN_NAME = 'session_token';

/**
 * Read the current better-auth session token from an Expo auth client, for use
 * as a **bearer** credential on a native {@link createNativeClient}.
 *
 * The Expo plugin persists the session as a cookie string in `SecureStore` and
 * exposes it via `getCookie()`; this pulls the `session_token` value out. Vela
 * carries that value as an `Authorization: Bearer …` header on HTTP mutations.
 * WebSockets deliberately require a separate short-lived `socketTicket`
 * provider, so bearer credentials never appear in URLs. Returns `null` when
 * signed out.
 *
 * Cookie parsing is split-on-`;` then split-on-the-first-`=`; a name matches
 * when it equals `session_token` or ends with `.session_token` (covering the
 * `better-auth.` and `__Secure-better-auth.` prefixes). The raw value is
 * returned verbatim — better-auth's bearer plugin decodes it if URL-encoded.
 */
export function expoBearerToken(authClient: { getCookie: () => string }): string | null {
  const cookie = authClient.getCookie();
  if (cookie === '') return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_TOKEN_NAME || name.endsWith(`.${SESSION_TOKEN_NAME}`)) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

/**
 * Adapt {@link expoBearerToken} into a `LiveClientOptions.authToken` provider —
 * a function that threads the current session token onto the HTTP Bearer
 * header. The core re-invokes it on every mutation, so a rotated token is
 * picked up automatically. Returns `undefined` when signed out.
 *
 * ```ts
 * const client = createNativeClient({ url, authToken: expoAuthToken(authClient) });
 * ```
 */
export function expoAuthToken(authClient: { getCookie: () => string }): () => string | undefined {
  return () => expoBearerToken(authClient) ?? undefined;
}
