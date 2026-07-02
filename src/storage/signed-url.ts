// Signed-URL utilities using HMAC-SHA256 via the Web Crypto API (edge-safe;
// no node:crypto). Verification uses crypto.subtle.verify for timing-safety.
// Pattern: https://developers.cloudflare.com/workers/examples/signing-requests/

export interface SignedUrlOptions {
  /** Time-to-live in seconds; a matching `expires` param is added + enforced. */
  expiresIn?: number;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Sign a URL (or path) with HMAC-SHA256, appending `signature` (and `expires`).
 * The signature covers `pathname + search` (minus the signature param). Returns
 * the full URL for absolute inputs, or `pathname?search` for relative ones.
 */
export async function signUrl(url: string, secret: string, options?: SignedUrlOptions): Promise<string> {
  const parsed = new URL(url, 'https://placeholder.local');
  const key = await importKey(secret);

  if (options?.expiresIn) {
    const expires = Math.floor(Date.now() / 1000) + options.expiresIn;
    parsed.searchParams.set('expires', String(expires));
  }

  const dataToSign = `${parsed.pathname}?${parsed.searchParams.toString()}`;
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dataToSign));
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
  const key = await importKey(secret);
  return crypto.subtle.verify('HMAC', key, fromBase64Url(signature), new TextEncoder().encode(dataToVerify));
}
