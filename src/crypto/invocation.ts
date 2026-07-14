// Per-invocation signed claims for the internal-dispatch seam (`ctx.run`). This
// is the security core: an in-app re-entry (a queue/schedule/workflow handler
// calling back into a route) carries a claim bound to the exact method, path,
// body hash, a short expiry, and a single-use nonce — NOT a shared static
// bearer. The `aud` tag partitions these tokens from `@SignedUrl` download URLs
// even when both reuse `URL_SIGNING_SECRET`.
//
// Shares the ONE HMAC/base64url definition in `./hmac` with `./signed-url`.

import { fromBase64Url, importHmacKey, toBase64Url } from './hmac';

/** Audience/purpose tag — the domain separator for invocation tokens. */
export const INVOCATION_AUDIENCE = 'vela:invoke' as const;

/** Default claim lifetime; invocations are short-lived by design. */
export const INVOCATION_DEFAULT_TTL_SECONDS = 60;

/**
 * The signed body of an internal invocation. Every field except `iss` is bound
 * into the HMAC, so tampering with any of them invalidates the signature.
 */
export interface InvocationClaim {
  /** Audience/purpose tag; always {@link INVOCATION_AUDIENCE}. */
  aud: typeof INVOCATION_AUDIENCE;
  /** UPPERCASE HTTP method, bound into the signature. */
  method: string;
  /** Composed path + search (what `UrlGeneratorService.urlFor` produces). */
  path: string;
  /** `base64url(SHA-256(body))`; `''` when there is no body. Closes swap-the-body replay. */
  bodyHash: string;
  /** Unix seconds; short TTL. Verification rejects once `now > exp`. */
  exp: number;
  /** `crypto.randomUUID()`; the single-use key checked by a `NonceStore`. */
  nonce: string;
  /** OPTIONAL observability label (workflow / queue name). NEVER used for authz. */
  iss?: string;
}

export interface VerifyInvocationOptions {
  /** Override "now" (unix seconds) for deterministic tests. */
  now?: number;
}

/**
 * The signed fields, joined into a canonical newline-delimited string. `iss` is
 * intentionally excluded — it is an observability label, never authorization
 * input, so it can change without breaking the signature.
 */
function canonicalString(claim: InvocationClaim): string {
  return [claim.aud, claim.method, claim.path, claim.bodyHash, String(claim.exp), claim.nonce].join(
    '\n',
  );
}

function isInvocationClaim(value: unknown): value is InvocationClaim {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.aud === INVOCATION_AUDIENCE &&
    typeof c.method === 'string' &&
    typeof c.path === 'string' &&
    typeof c.bodyHash === 'string' &&
    typeof c.exp === 'number' &&
    typeof c.nonce === 'string' &&
    (c.iss === undefined || typeof c.iss === 'string')
  );
}

/**
 * Sign a claim, producing `base64url(json(claim)).base64url(hmac)`. The token
 * is opaque to the caller — only a holder of the same secret can verify it.
 */
export async function signInvocation(claim: InvocationClaim, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonicalString(claim)),
  );
  const claimPart = toBase64Url(new TextEncoder().encode(JSON.stringify(claim)));
  return `${claimPart}.${toBase64Url(signature)}`;
}

/**
 * Verify an invocation token, FAIL-CLOSED at every step: any parse failure,
 * wrong `aud`, expired `exp`, or bad signature returns `null` — never an
 * exception that could leak state, and never the secret or expected signature.
 * Checks run in order: parseable → `aud` → `exp` in the future → signature
 * (constant-time via `crypto.subtle.verify`).
 *
 * On success it returns the claim; the CALLER then binds it to the live request
 * by checking `method` / `path` / `bodyHash` and reserving the `nonce` (the
 * guard does this). Returning the claim rather than a boolean lets the guard do
 * those checks against authenticated values.
 */
export async function verifyInvocation(
  token: string,
  secret: string,
  opts: VerifyInvocationOptions = {},
): Promise<InvocationClaim | null> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) return null;

  let claim: InvocationClaim;
  try {
    const json = new TextDecoder().decode(fromBase64Url(token.slice(0, dot)));
    const parsed: unknown = JSON.parse(json);
    if (!isInvocationClaim(parsed)) return null;
    claim = parsed;
  } catch {
    return null;
  }

  if (claim.aud !== INVOCATION_AUDIENCE) return null;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claim.exp) || now > claim.exp) return null;

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64Url(token.slice(dot + 1));
  } catch {
    return null;
  }

  const key = await importHmacKey(secret);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(canonicalString(claim)),
    );
  } catch {
    return null;
  }
  return valid ? claim : null;
}
