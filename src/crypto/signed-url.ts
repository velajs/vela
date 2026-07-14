// Signed-URL utilities using HMAC-SHA256 via the Web Crypto API (edge-safe;
// no node:crypto). Verification uses crypto.subtle.verify for timing-safety.
// Pattern: https://developers.cloudflare.com/workers/examples/signing-requests/
//
// This is the canonical home for the util. `@velajs/vela/storage` re-exports it
// (see src/storage/index.ts) so the storage subpath API is unchanged, while
// core (the URL generator + signed-URL guard) imports it here directly — core
// never reaches into a published subpath.
//
// The HMAC / base64url plumbing lives in `./hmac` — a single definition shared
// with `./invocation` so no security verify path drifts from a byte-similar copy.

import { fromBase64Url, importHmacKey, toBase64Url } from './hmac';

export interface SignedUrlOptions {
  /** Time-to-live in seconds; a matching `expires` param is added + enforced. */
  expiresIn?: number;
}

/**
 * Sign a URL (or path) with HMAC-SHA256, appending `signature` (and `expires`).
 * The signature covers `pathname + search` (minus the signature param). Returns
 * the full URL for absolute inputs, or `pathname?search` for relative ones.
 */
export async function signUrl(
  url: string,
  secret: string,
  options?: SignedUrlOptions,
): Promise<string> {
  const parsed = new URL(url, 'https://placeholder.local');
  const key = await importHmacKey(secret);

  if (options?.expiresIn) {
    const expires = Math.floor(Date.now() / 1000) + options.expiresIn;
    parsed.searchParams.set('expires', String(expires));
  }

  const dataToSign = `${parsed.pathname}?${parsed.searchParams.toString()}`;
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(dataToSign),
  );
  parsed.searchParams.set('signature', toBase64Url(signatureBuffer));

  return url.startsWith('http')
    ? parsed.toString()
    : `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

/** Verify a signed URL (timing-safe) and enforce `expires`. */
export async function verifySignedUrl(url: string, secret: string): Promise<boolean> {
  const parsed = new URL(url, 'https://placeholder.local');
  const signature = parsed.searchParams.get('signature');
  if (!signature) return false;

  const expires = parsed.searchParams.get('expires');
  if (expires) {
    const expiryTime = parseInt(expires, 10);
    if (Number.isNaN(expiryTime) || Math.floor(Date.now() / 1000) > expiryTime) return false;
  }

  parsed.searchParams.delete('signature');
  const dataToVerify = `${parsed.pathname}?${parsed.searchParams.toString()}`;
  const key = await importHmacKey(secret);
  return crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(dataToVerify),
  );
}
