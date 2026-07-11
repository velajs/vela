/**
 * ETag/If-Match optimistic concurrency (hono-crud 0.13 parity): a STRONG
 * content-hash ETag — SHA-256 over the canonicalized (recursively key-sorted)
 * JSON of the record, truncated to 32 hex chars, double-quoted.
 *
 * The hashed representation is the record AFTER computed fields, policy mask,
 * and serialization profile but WITHOUT request field-selection — the token
 * must be stable across `?fields=` variants so a read's ETag matches the
 * update-side If-Match comparison (the caller builds that representation; this
 * module only hashes and matches).
 *
 * Parity note: hono-crud returns 409 CONFLICT on an If-Match mismatch (not
 * 412) — the engine follows suit via `ConflictException`.
 */

type Json = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  // JSON.stringify would throw on BigInt and Object.keys(new Date()) is [] —
  // normalize both so exotic column types hash by VALUE, never as `{}`.
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    // Non-plain objects (Map/Set/class instances) have no stable key shape —
    // hash their string form rather than collapsing them all to `{}`.
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return String(value);
    const sorted: Json = {};
    for (const key of Object.keys(value as Json).sort()) {
      sorted[key] = canonicalize((value as Json)[key]);
    }
    return sorted;
  }
  return value;
}

/** Strong content-hash ETag for one record (double-quoted, 32 hex chars). */
export async function generateETag(record: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(canonicalize(record));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  return `"${hex}"`;
}

function listedTags(header: string): string[] {
  return header.split(',').map((tag) => tag.trim());
}

/**
 * `If-Match` precondition: an ABSENT header is unconditional (passes); `*`
 * matches any current representation; otherwise the current tag must appear
 * in the list.
 */
export function matchesIfMatch(header: string | null | undefined, tag: string): boolean {
  if (header === null || header === undefined || header === '') return true;
  if (header.trim() === '*') return true;
  return listedTags(header).includes(tag);
}

/**
 * `If-None-Match`: an absent header never matches; `*` always matches;
 * otherwise true when the current tag appears in the list (weak-prefixed
 * entries compare by their opaque tag).
 */
export function matchesIfNoneMatch(header: string | null | undefined, tag: string): boolean {
  if (header === null || header === undefined || header === '') return false;
  if (header.trim() === '*') return true;
  return listedTags(header).some((entry) => entry === tag || entry === `W/${tag}`);
}
