import { StorageError } from './storage.error';

// Object-key hygiene shared by the facade (prefix scoping) and the HTTP
// controller (post-authorize re-sanitization). The rules block the classic
// traversal / injection footguns without being so strict that legitimate
// keys (nested "folders", dots, spaces) are rejected.

// Control characters: C0 range (0x00-0x1F) plus DEL (0x7F).
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();

/**
 * True when `key` is a safe object key:
 * - non-empty, not longer than 1024 bytes (S3's limit)
 * - no leading `/`
 * - no `.` / `..` path segments (traversal)
 * - no control characters
 * - no backslashes (Windows-style separators)
 */
export function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || encoder.encode(key).byteLength > 1024) {
    return false;
  }
  if (key.startsWith('/')) return false;
  if (key.includes('\\')) return false;
  if (CONTROL_CHARS.test(key)) return false;
  for (const segment of key.split('/')) {
    if (segment === '.' || segment === '..') return false;
  }
  return true;
}

/** Return `key` if safe, else throw `StorageError('InvalidKey')`. */
export function sanitizeKey(key: string): string {
  if (!isSafeKey(key)) {
    throw new StorageError('InvalidKey', `unsafe object key: ${JSON.stringify(key)}`);
  }
  return key;
}

/** Normalize a prefix: drop leading/trailing slashes, collapse to '' when empty. */
export function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return '';
  let start = 0;
  let end = prefix.length;
  while (start < end && prefix.charCodeAt(start) === 47) start++;
  while (end > start && prefix.charCodeAt(end - 1) === 47) end--;
  return prefix.slice(start, end);
}

/** Join a normalized prefix and a key with a single '/'. */
export function joinKey(prefix: string, key: string): string {
  return prefix ? `${prefix}/${key}` : key;
}

/** Strip a normalized prefix from a stored key (for surfacing to callers). */
export function stripPrefix(prefix: string, key: string): string {
  if (!prefix) return key;
  const withSlash = `${prefix}/`;
  return key.startsWith(withSlash) ? key.slice(withSlash.length) : key;
}
