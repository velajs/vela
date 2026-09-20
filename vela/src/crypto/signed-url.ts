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
  expiresIn: number;
  /** HTTP method allowed to present this URL. */
  method: string;
  /** Explicit domain-separation purpose for the URL's capability. */
  purpose: string;
}

export type VerifySignedUrlOptions = Pick<SignedUrlOptions, 'method' | 'purpose'>;

export const HTTP_SIGNED_URL_PURPOSE = 'vela:http-route';
export const STORAGE_SIGNED_URL_PURPOSE = 'vela:storage';

const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const METHOD_RE = /^[A-Z]+$/;
const PURPOSE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function signingScope(options: VerifySignedUrlOptions | undefined): {
  method: string;
  purpose: string;
} {
  if (!options) throw new Error('Signed URL method and purpose are required');
  const method = options.method.toUpperCase();
  const purpose = options.purpose;
  if (!METHOD_RE.test(method)) throw new Error(`Invalid signed URL method: ${method}`);
  if (!PURPOSE_RE.test(purpose)) throw new Error(`Invalid signed URL purpose: ${purpose}`);
  return { method, purpose };
}

function signingPayload(parsed: URL, options: VerifySignedUrlOptions): string {
  const { method, purpose } = signingScope(options);
  return `vela-signed-url-v2\n${purpose}\n${method}\n${parsed.pathname}?${parsed.searchParams.toString()}`;
}

/**
 * Sign a URL (or path) with HMAC-SHA256, appending `signature` (and `expires`).
 * The signature covers purpose + HTTP method + `pathname + search` (minus the
 * signature param). Returns the full URL for absolute inputs, or
 * `pathname?search` for relative ones.
 */
export async function signUrl(
  url: string,
  secret: string,
  options: SignedUrlOptions,
): Promise<string> {
  if (secret.length === 0) throw new Error('Signed URL secret must not be empty');
  const parsed = new URL(url, 'https://placeholder.local');
  const key = await importHmacKey(secret);

  if (!Number.isSafeInteger(options?.expiresIn) || options.expiresIn <= 0) {
    throw new Error('Signed URL expiresIn must be a positive safe integer number of seconds');
  }
  const expires = Math.floor(Date.now() / 1000) + options.expiresIn;
  if (!Number.isSafeInteger(expires)) throw new Error('Signed URL expiry is out of range');
  parsed.searchParams.set('expires', String(expires));

  const dataToSign = signingPayload(parsed, options);
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

/** Verify a scoped signed URL (timing-safe) and enforce `expires`. Never throws. */
export async function verifySignedUrl(
  url: string,
  secret: string,
  options: VerifySignedUrlOptions,
): Promise<boolean> {
  try {
    if (secret.length === 0) return false;
    const parsed = new URL(url, 'https://placeholder.local');
    const signature = parsed.searchParams.get('signature');
    if (!signature || !SIGNATURE_RE.test(signature)) return false;

    const expires = parsed.searchParams.get('expires');
    if (!expires || !/^\d+$/.test(expires)) return false;
    const expiryTime = Number(expires);
    if (!Number.isSafeInteger(expiryTime) || Math.floor(Date.now() / 1000) >= expiryTime) {
      return false;
    }

    parsed.searchParams.delete('signature');
    const dataToVerify = signingPayload(parsed, options);
    const key = await importHmacKey(secret);
    return await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(signature),
      new TextEncoder().encode(dataToVerify),
    );
  } catch {
    return false;
  }
}
