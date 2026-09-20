/**
 * `@velajs/errors/fingerprint` — zero-dependency, cross-runtime error grouping.
 *
 * Collapses noisy repeats of the same error into one stable "issue" identity: a
 * 16-hex-character hash over the function path plus a *normalized* message, so a
 * live in-flight error and one recomputed later from a persisted log row fold
 * onto the same fingerprint. The machine `code` rides along as metadata and is
 * deliberately excluded from the hash, so the redacted wire view produced by
 * `toErrorBody` and the raw server-side error group together.
 *
 * The digest is a portable synchronous SHA-256 (see `./sha256`) truncated to 16
 * hex chars — content-addressing only, never a security or MAC primitive.
 *
 * The message-normalization / grouping approach is inspired by
 * `@superlog/fingerprint` (Apache-2.0); this is an independent implementation.
 */
import { sha256Hex } from './sha256';

/**
 * Heuristic generation of {@link bucketMessage}. Bump it whenever the
 * normalizer's rules change: changed heuristics re-partition history (they may
 * split one group into several or merge several into one), so a consumer that
 * persists fingerprints stores this alongside each hash to know which
 * generation produced it and when a recompute/backfill is due.
 */
export const FINGERPRINT_VERSION: number = 1;

/**
 * Upper bound on the raw message length fed to the normalizer's regexes. A few
 * of them (the email and long-run patterns especially) can backtrack
 * super-linearly on a long delimiter-free run, and an error message can carry
 * attacker-influenced input of unbounded size — so clamp first to keep the
 * regex work bounded (a ReDoS guard). The final bucket is capped far below this
 * anyway, so the clamp is transparent for any real message.
 */
const MAX_INPUT_LENGTH = 1024;

/** Cap on the normalized bucket so one runaway message can't bloat the key. */
const MAX_BUCKET_LENGTH = 160;

/** Hex length of the truncated digest used as the grouping id. */
const HASH_LENGTH = 16;

/** Namespaces the hash so a fingerprint can't collide with another content hash. */
const SCHEME = 'velajs.errors/fingerprint';

/**
 * Ordered noise-stripping rules applied to a message before hashing. Each
 * replaces a class of per-occurrence identifier with a stable placeholder, so
 * two errors that differ only in their variable parts land in the same bucket.
 * Order matters: broader shapes (urls, timestamps) run before the greedy
 * numeric/id sweeps that would otherwise chew their digits.
 */
const NOISE_RULES: readonly (readonly [RegExp, string])[] = [
  // Whole URLs (before path/number rules can nibble their insides).
  [/https?:\/\/\S+/gi, '[url]'],
  // Email addresses.
  [/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email]'],
  // RFC-4122 UUIDs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]'],
  // ISO-8601-ish timestamps (before the ip/number rules touch their digits).
  [/\b\d{4}-\d{2}-\d{2}[t ][\d:.]+z?(?:[+-]\d{2}:?\d{2})?\b/gi, '[time]'],
  // IPv4 addresses with an optional port.
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[ip]'],
  // Unix-style request/filesystem paths at a token boundary — keeps in-word
  // slashes (client/server, and/or) intact while folding a scanner's probed
  // paths (/wp-admin, /.env, /.git/config) onto one placeholder.
  [/(^|\s)\/\S*/g, '$1[path]'],
  // Windows drive-letter paths.
  [/\b[a-z]:\\[^\s]*/gi, '[path]'],
  // Hex literals (0x…).
  [/\b0x[0-9a-f]+\b/gi, '[hex]'],
  // Long opaque ids: tokens, hashes, base-ish ids. Threshold high enough to
  // spare ordinary words while catching machine identifiers.
  [/\b[a-z0-9_]{20,}\b/gi, '[id]'],
  // Any remaining bare integer.
  [/\b\d+\b/g, '[num]'],
];

/**
 * Normalize an error message into its grouping bucket: strip per-occurrence
 * noise (urls, uuids, ips, request/filesystem paths, long ids, numbers) and
 * fold whitespace/case, so occurrences of the same logical error collapse to
 * one bucket. Exported for direct testing of the normalization heuristics.
 */
export const bucketMessage = (message: string): string => {
  if (message.length === 0) {
    return '';
  }

  let text = message.length > MAX_INPUT_LENGTH ? message.slice(0, MAX_INPUT_LENGTH) : message;

  for (const [pattern, placeholder] of NOISE_RULES) {
    text = text.replace(pattern, placeholder);
  }

  text = text.replace(/\s+/g, ' ').trim().toLowerCase();

  return text.length > MAX_BUCKET_LENGTH ? text.slice(0, MAX_BUCKET_LENGTH) : text;
};

/** Everything a fingerprint source can supply. */
export interface ErrorFingerprintInput {
  /**
   * What raised the error — the invoked function/route path, e.g.
   * `messages:list`. Part of the grouping key.
   */
  functionPath: string;
  /** Human-readable message (may embed user input); normalized into the key. */
  message: string;
  /**
   * Machine error code, when known. Pure metadata: **never folded into the
   * hash**, so the redacted wire error (which may rewrite or drop the code) and
   * the raw server-side error still produce the same fingerprint.
   */
  code?: string;
}

/**
 * Fold an error into its stable 16-hex-character grouping fingerprint. Pure and
 * synchronous, safe to call per row when grouping a log page. The same
 * `functionPath` and logically-equal `message` always yield the same hash
 * regardless of the `code` supplied or per-occurrence noise in the message.
 */
export const fingerprintError = (input: ErrorFingerprintInput): string => {
  const source = input.functionPath.length > 0 ? input.functionPath : 'unknown';
  const canonical = `${SCHEME}\n${source}\n${bucketMessage(input.message)}`;
  return sha256Hex(canonical).slice(0, HASH_LENGTH);
};

export { sha256Hex } from './sha256';
