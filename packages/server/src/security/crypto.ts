/**
 * Edge-safe crypto primitives shared by the Studio security layer.
 *
 * Web Crypto + `TextEncoder`/`btoa`/`atob` only — no `node:*`, no `Buffer`, no
 * `process`. Everything here runs unchanged on Workers, Deno, Bun, and Node 24.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 encode a string to bytes. */
export function utf8(input: string): Uint8Array {
  return encoder.encode(input);
}

/** Decode UTF-8 bytes back to a string. */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** URL-safe base64 encode (no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Strict base64url alphabet — no padding, no whitespace, no `+`/`/`. */
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * URL-safe base64 decode. Returns `null` on malformed input rather than
 * throwing.
 *
 * `atob` is deliberately forgiving — it silently ignores ASCII whitespace and
 * accepts stray padding — which for token bodies is a footgun: two distinct
 * strings could decode to the same bytes. We reject anything outside the strict
 * base64url alphabet up front, so only exact `base64UrlEncode` output round-trips.
 */
export function base64UrlDecode(input: string): Uint8Array | null {
  if (!BASE64URL_RE.test(input)) return null;
  try {
    const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Cryptographically-random URL-safe nonce of `byteLength` bytes. */
export function randomToken(byteLength = 16): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** SHA-256 digest of bytes. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return new Uint8Array(digest);
}

const HKDF_SALT = utf8('vela:studio:hkdf:v1');

/**
 * Derive a signing-only HMAC-SHA256 key from a master secret via HKDF. The
 * `info` label domain-separates keys minted from the same master (sub-tokens
 * vs confirm-tokens get independent keys).
 */
export async function deriveHmacKey(secret: string, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    utf8(secret) as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT as unknown as BufferSource,
      info: utf8(info) as unknown as BufferSource,
    },
    base,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** HMAC-SHA256 sign bytes with a derived key. */
export async function hmacSign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', key, data as unknown as BufferSource);
  return new Uint8Array(sig);
}

/** Canonical JSON: object keys sorted recursively so hashes are order-stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted()) out[key] = sortDeep(record[key]);
    return out;
  }
  return value;
}
