// The ONE definition of the HMAC-SHA256 / base64url plumbing shared by every
// signing path in core (signed-url.ts and invocation.ts). A crypto verify path
// must have a single source of truth — byte-similar copies of key import,
// base64url, and digest helpers can silently drift and open a verification hole.
// Everything here is edge-safe Web Crypto (no `node:crypto`, no `Buffer`).

/**
 * Bounded FIFO cache of imported HMAC `CryptoKey`s, keyed by secret. Importing a
 * key per verify is pure overhead when one secret signs thousands of requests;
 * the bound stops an adversarial multi-tenant secret space from growing the
 * cache without limit. Never logged.
 */
const KEY_CACHE_MAX = 64;
const keyCache = new Map<string, CryptoKey>();

/** Import (or reuse a cached) non-extractable HMAC-SHA256 key for `secret`. */
export async function importHmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

  // FIFO eviction: drop the oldest entry once the bound is hit.
  if (keyCache.size >= KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  keyCache.set(secret, key);
  return key;
}

/** Encode bytes as unpadded base64url. */
export function toBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode an unpadded base64url string back to bytes. Throws on malformed input. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url(SHA-256(bytes)) — the content-address used for body binding. */
export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toBase64Url(digest);
}
