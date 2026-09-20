// Edge-safe base64 — NO `Buffer` (banned by the edge-runtime audit).
// Uses `btoa`/`atob` over chunked `String.fromCharCode`, present on every
// target runtime (Workers, Deno, Bun, Node 20+, browsers).

// Chunk stays <= 0x8000 so the spread into String.fromCharCode never exceeds
// the engine argument limit.
const CHUNK = 0x8000;

/** Encode bytes to standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode standard base64 to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encode a UTF-8 string to base64 (unicode-safe, unlike raw `btoa`). */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** URL-safe base64 (base64url) without padding — used by SigV4 / policies. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
