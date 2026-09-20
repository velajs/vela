import { beforeEach, describe, expect, it } from 'vitest';
import { JWKS_CACHE_MAX, clearJwksCache, getRemoteJwks, jwksCacheSize } from '../jwks-cache';

const uri = (n: number): string => `https://issuer-${n}.example.com/.well-known/jwks.json`;

describe('JWKS cache', () => {
  beforeEach(() => clearJwksCache());

  it('returns the same getter instance per JWKS URI (one createRemoteJWKSet per issuer)', () => {
    const a = getRemoteJwks(uri(1));
    const b = getRemoteJwks(uri(1));
    expect(b).toBe(a);
    expect(jwksCacheSize()).toBe(1);
  });

  it('returns distinct getters for distinct URIs', () => {
    const a = getRemoteJwks(uri(1));
    const b = getRemoteJwks(uri(2));
    expect(b).not.toBe(a);
    expect(jwksCacheSize()).toBe(2);
  });

  it('is bounded and evicts FIFO past the cap', () => {
    const first = getRemoteJwks(uri(0));
    for (let n = 1; n < JWKS_CACHE_MAX; n += 1) getRemoteJwks(uri(n));
    expect(jwksCacheSize()).toBe(JWKS_CACHE_MAX);

    // One more distinct issuer evicts the earliest-inserted entry.
    getRemoteJwks(uri(JWKS_CACHE_MAX));
    expect(jwksCacheSize()).toBe(JWKS_CACHE_MAX);

    // The evicted first URI is rebuilt fresh (new identity)…
    const firstAgain = getRemoteJwks(uri(0));
    expect(firstAgain).not.toBe(first);
    // …while a still-cached entry keeps its identity.
    expect(getRemoteJwks(uri(JWKS_CACHE_MAX))).toBe(getRemoteJwks(uri(JWKS_CACHE_MAX)));
  });

  it('clearJwksCache resets the cache', () => {
    getRemoteJwks(uri(1));
    getRemoteJwks(uri(2));
    expect(jwksCacheSize()).toBe(2);
    clearJwksCache();
    expect(jwksCacheSize()).toBe(0);
  });
});
