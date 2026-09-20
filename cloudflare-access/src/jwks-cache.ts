import type { JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet } from 'jose';

/**
 * How many distinct issuers one isolate will hold key-getters for at a time. A
 * fixed ceiling (in the spirit of the other bounded caches in the codebase, such
 * as vela's HMAC key cache) stops a caller that cycles through many issuer values
 * from growing the map indefinitely. Past the ceiling the entry inserted longest
 * ago is dropped first.
 */
export const JWKS_CACHE_MAX = 32;

/** Minimum gap `jose` enforces between two successful key fetches (ms). */
const COOLDOWN_DURATION_MS = 30_000;
/** Window during which `jose` serves a fetched key set without re-checking it (ms). */
const CACHE_MAX_AGE_MS = 600_000;

/**
 * Keyed by JWKS URI, one `jose` getter per issuer, living as long as the isolate.
 *
 * That getter already does the hard parts internally: it caches the keys with a
 * cooldown, re-fetches automatically when a token arrives under an unseen `kid`
 * (the shape of key rotation), and remembers a failed fetch for the cooldown
 * window. Building a fresh getter on every request throws all of that away and
 * turns each verification into a round-trip to the certs endpoint, so reuse is
 * the intended pattern — hence this cache.
 */
const cache = new Map<string, JWTVerifyGetKey>();

/**
 * Hand back the getter for `jwksUri`, building and storing one the first time it
 * is asked for. Eviction is FIFO: once {@link JWKS_CACHE_MAX} is reached the
 * oldest entry is removed to make room for the newcomer.
 */
export const getRemoteJwks = (jwksUri: string): JWTVerifyGetKey => {
  const existing = cache.get(jwksUri);
  if (existing !== undefined) return existing;

  if (cache.size >= JWKS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  const getter = createRemoteJWKSet(new URL(jwksUri), {
    cooldownDuration: COOLDOWN_DURATION_MS,
    cacheMaxAge: CACHE_MAX_AGE_MS,
  });
  cache.set(jwksUri, getter);
  return getter;
};

/** Drop all cached JWKS getters. Primarily for tests. */
export const clearJwksCache = (): void => {
  cache.clear();
};

/** Current number of cached JWKS getters. Primarily for tests. */
export const jwksCacheSize = (): number => cache.size;
