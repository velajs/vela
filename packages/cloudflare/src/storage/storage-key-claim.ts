/** R2-compatible object-key claim bound. Keeps decode work predictably small. */
export const MAX_STORAGE_KEY_BYTES = 1024;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ROOT_TOKEN_PATTERNS: Record<string, string> = {
  date: '\\d{4}-\\d{2}-\\d{2}',
  year: '\\d{4}',
  month: '(?:0[1-9]|1[0-2])',
  day: '(?:0[1-9]|[12]\\d|3[01])',
  uuid: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}',
};

/** Encode an object key as an opaque, canonical base64url query claim. */
export function encodeStorageKeyClaim(key: string): string {
  const bytes = new TextEncoder().encode(key);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_STORAGE_KEY_BYTES) {
    throw new Error(`Storage key must be 1–${MAX_STORAGE_KEY_BYTES} UTF-8 bytes`);
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode exactly one canonical base64url layer. Malformed/non-UTF-8 claims return undefined. */
export function decodeStorageKeyClaim(claim: string): string | undefined {
  try {
    if (
      claim.length === 0 ||
      claim.length > Math.ceil((MAX_STORAGE_KEY_BYTES * 4) / 3) ||
      !BASE64URL_RE.test(claim) ||
      claim.length % 4 === 1
    ) {
      return undefined;
    }
    const base64 = claim.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_STORAGE_KEY_BYTES) return undefined;
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return encodeStorageKeyClaim(decoded) === claim ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isDotSegment(segment: string): boolean {
  let decoded = segment;
  for (let i = 0; i < 2; i++) {
    if (decoded === '' || decoded === '.' || decoded === '..') return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded === '' || decoded === '.' || decoded === '..';
}

function rootSegmentPattern(segment: string): string {
  let pattern = '';
  let cursor = 0;
  for (const match of segment.matchAll(/\{(date|year|month|day|uuid)\}/g)) {
    pattern += segment.slice(cursor, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern += ROOT_TOKEN_PATTERNS[match[1]!]!;
    cursor = match.index! + match[0].length;
  }
  pattern += segment.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return pattern;
}

/** Assert a canonical key is beneath a static or templated configured root. */
export function isStorageKeyWithinRoot(key: string, root: string | undefined): boolean {
  const segments = (root ?? '').split(/[/\\]+/).filter((segment) => !isDotSegment(segment));
  if (segments.length === 0) return key.length > 0;
  const rootPattern = segments.map(rootSegmentPattern).join('/');
  return new RegExp(`^(?:${rootPattern})(?:/|$)`).test(key);
}
