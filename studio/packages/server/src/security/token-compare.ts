/**
 * Constant-time string comparison for secrets (bearer tokens, signatures).
 *
 * Uses the HMAC-both-sides-with-a-random-key trick: both inputs are HMAC'd
 * under a per-call random key, then the fixed-width 32-byte digests are XOR-
 * accumulated. Because the digests are always equal length, the compare leaks
 * neither the secret's length nor an early-exit timing signal, and an attacker
 * cannot precompute the key. Web Crypto only — edge-safe.
 */
import { utf8 } from './crypto';

/** True iff `a` and `b` are byte-identical, in time independent of their contents. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, utf8(a) as unknown as BufferSource),
    crypto.subtle.sign('HMAC', key, utf8(b) as unknown as BufferSource),
  ]);
  const x = new Uint8Array(macA);
  const y = new Uint8Array(macB);
  // Digests are both 32 bytes; the loop bound and work are constant.
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
