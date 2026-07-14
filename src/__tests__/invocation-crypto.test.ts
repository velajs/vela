import { describe, it, expect } from 'vitest';
import {
  signInvocation,
  verifyInvocation,
  INVOCATION_AUDIENCE,
  INVOCATION_DEFAULT_TTL_SECONDS,
} from '../index.js';
import type { InvocationClaim } from '../index.js';

const SECRET = 'invocation-signing-secret';

function baseClaim(overrides: Partial<InvocationClaim> = {}): InvocationClaim {
  return {
    aud: INVOCATION_AUDIENCE,
    method: 'POST',
    path: '/tasks/run?tenant=acme',
    bodyHash: '',
    exp: Math.floor(Date.now() / 1000) + INVOCATION_DEFAULT_TTL_SECONDS,
    nonce: crypto.randomUUID(),
    ...overrides,
  };
}

/**
 * Adversarial token forger for NEGATIVE tests only: signs an arbitrary
 * claim-shaped object (e.g. a wrong `aud`) that the type-safe `signInvocation`
 * would refuse to build. Uses only public Web Crypto, mirroring the token
 * format so we can exercise `verifyInvocation`'s gates against a foreign token.
 */
async function forgeToken(claim: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const canonical = [
    claim.aud,
    claim.method,
    claim.path,
    claim.bodyHash,
    String(claim.exp),
    claim.nonce,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(canonical));
  const b64 = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const claimPart = b64(enc.encode(JSON.stringify(claim)).buffer as ArrayBuffer);
  return `${claimPart}.${b64(sig)}`;
}

describe('invocation crypto — signInvocation / verifyInvocation', () => {
  it('round-trips a claim: verify returns the exact claim', async () => {
    const claim = baseClaim({ iss: 'orderPipeline' });
    const token = await signInvocation(claim, SECRET);
    const verified = await verifyInvocation(token, SECRET);
    expect(verified).toEqual(claim);
  });

  it('rejects a tampered signature with null', async () => {
    const token = await signInvocation(baseClaim(), SECRET);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(await verifyInvocation(flipped, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signInvocation(baseClaim(), SECRET);
    expect(await verifyInvocation(token, 'other-secret')).toBeNull();
  });

  it('rejects an expired claim with null', async () => {
    const expired = baseClaim({ exp: Math.floor(Date.now() / 1000) - 10 });
    const token = await signInvocation(expired, SECRET);
    expect(await verifyInvocation(token, SECRET)).toBeNull();
  });

  it('honours an injected `now` for deterministic expiry checks', async () => {
    const claim = baseClaim({ exp: 1_000 });
    const token = await signInvocation(claim, SECRET);
    expect(await verifyInvocation(token, SECRET, { now: 999 })).toEqual(claim);
    expect(await verifyInvocation(token, SECRET, { now: 1_001 })).toBeNull();
  });

  it('rejects a validly-signed token whose aud is not vela:invoke (partition gate)', async () => {
    const foreign = await forgeToken({ ...baseClaim(), aud: 'vela:download' }, SECRET);
    // The signature is valid over its own canonical string, yet the aud gate
    // fails closed — a same-secret token minted for another purpose can never
    // pass as an invocation.
    expect(await verifyInvocation(foreign, SECRET)).toBeNull();
  });

  it('rejects malformed tokens (no dot, empty parts, non-base64) with null', async () => {
    expect(await verifyInvocation('', SECRET)).toBeNull();
    expect(await verifyInvocation('no-dot-here', SECRET)).toBeNull();
    expect(await verifyInvocation('.sig', SECRET)).toBeNull();
    expect(await verifyInvocation('claim.', SECRET)).toBeNull();
    expect(await verifyInvocation('!!!.@@@', SECRET)).toBeNull();
  });

  it('never leaks the secret in any code path (returns null, throws nothing)', async () => {
    const token = await signInvocation(baseClaim(), SECRET);
    // Verification never throws — even garbage input resolves to null, so no
    // exception message could carry the secret or an expected signature.
    await expect(verifyInvocation('garbage.token', SECRET)).resolves.toBeNull();
    await expect(verifyInvocation(token, 'wrong')).resolves.toBeNull();
  });
});
