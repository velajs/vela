import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { cloudflareAccessIssuer } from '../issuer';
import type { AccessKeySet } from '../types';
import { assertVerifyOptions, normalizeAudiences, verifyAccessJwt, verifyRequest } from '../verify';
import {
  makeKeyMaterial,
  mintHs256Token,
  mintToken,
  requestWithHeader,
  tamperSignature,
  type TestKeyMaterial,
} from './harness';

const preset = cloudflareAccessIssuer('acme');
const AUD = 'app-audience-tag';

let keys: TestKeyMaterial;
const keySet = (): AccessKeySet => keys.jwks;

async function setup(): Promise<void> {
  keys = await makeKeyMaterial();
}

describe('normalizeAudiences', () => {
  it('keeps non-empty tags and dedupes array vs single input', () => {
    expect(normalizeAudiences('a')).toEqual(['a']);
    expect(normalizeAudiences(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('throws fail-closed on an empty / whitespace-only audience', () => {
    expect(() => normalizeAudiences('')).toThrow(/audience is mandatory/);
    expect(() => normalizeAudiences([])).toThrow(/audience is mandatory/);
    expect(() => normalizeAudiences(['', ''])).toThrow(/audience is mandatory/);
  });
});

describe('assertVerifyOptions', () => {
  it('accepts a resolvable preset + non-empty aud', () => {
    expect(() => assertVerifyOptions({ preset, aud: AUD })).not.toThrow();
  });

  it('throws when the audience is empty (never default-open)', () => {
    expect(() => assertVerifyOptions({ preset, aud: '' })).toThrow(/audience is mandatory/);
  });
});

describe('verifyAccessJwt', () => {
  it('returns the claims for a valid RS256 token', async () => {
    await setup();
    const token = await mintToken({
      privateKey: keys.privateKey,
      kid: keys.kid,
      issuer: preset.issuer,
      audience: AUD,
      subject: 'user-42',
      claims: { email: 'ada@example.com', groups: ['admins'] },
    });

    const claims = await verifyAccessJwt(token, { preset, aud: AUD, keySet: keySet() });
    expect(claims.sub).toBe('user-42');
    expect(claims.email).toBe('ada@example.com');
    expect(claims.groups).toEqual(['admins']);
    expect(claims.iss).toBe(preset.issuer);
  });

  it('rejects a token minted for a different audience', async () => {
    await setup();
    const token = await mintToken({
      privateKey: keys.privateKey,
      issuer: preset.issuer,
      audience: 'some-other-app',
    });
    await expect(verifyAccessJwt(token, { preset, aud: AUD, keySet: keySet() })).rejects.toThrow();
  });

  it('rejects a token whose issuer does not match the preset', async () => {
    await setup();
    const token = await mintToken({
      privateKey: keys.privateKey,
      issuer: 'https://evil.cloudflareaccess.com',
      audience: AUD,
    });
    await expect(verifyAccessJwt(token, { preset, aud: AUD, keySet: keySet() })).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    await setup();
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = await mintToken({
      privateKey: keys.privateKey,
      issuer: preset.issuer,
      audience: AUD,
      expiresAt: past,
    });
    await expect(verifyAccessJwt(token, { preset, aud: AUD, keySet: keySet() })).rejects.toThrow();
  });

  it('rejects a correctly signed token with no exp claim', async () => {
    await setup();
    const token = await new SignJWT({ sub: 'user-42' })
      .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
      .setIssuer(preset.issuer)
      .setAudience(AUD)
      .sign(keys.privateKey);
    await expect(verifyAccessJwt(token, { preset, aud: AUD, keySet: keySet() })).rejects.toThrow(
      /finite exp claim is required/,
    );
  });

  it('rejects an HS256-signed forgery (RS256 pin)', async () => {
    await setup();
    const secret = new Uint8Array(32).fill(7);
    const token = await mintHs256Token(secret, { issuer: preset.issuer, audience: AUD });
    // Verified against the RSA JWKS with the RS256 pin — the alg mismatch is
    // rejected before any signature check.
    await expect(verifyAccessJwt(token, { preset, aud: AUD, keySet: keySet() })).rejects.toThrow();
  });

  it('rejects a token whose signature has been tampered (first base64url char flipped)', async () => {
    await setup();
    const token = await mintToken({
      privateKey: keys.privateKey,
      issuer: preset.issuer,
      audience: AUD,
      subject: 'user-42',
    });
    const tampered = tamperSignature(token);
    expect(tampered).not.toBe(token);
    await expect(
      verifyAccessJwt(tampered, { preset, aud: AUD, keySet: keySet() }),
    ).rejects.toThrow();
  });

  it('throws fail-closed when the audience is unset (no default-open)', async () => {
    await setup();
    const token = await mintToken({
      privateKey: keys.privateKey,
      issuer: preset.issuer,
      audience: AUD,
    });
    await expect(verifyAccessJwt(token, { preset, aud: '', keySet: keySet() })).rejects.toThrow(
      /audience is mandatory/,
    );
  });
});

describe('verifyRequest', () => {
  it('verifies a token off the assertion header', async () => {
    await setup();
    const token = await mintToken({
      privateKey: keys.privateKey,
      issuer: preset.issuer,
      audience: AUD,
      subject: 'user-7',
    });
    const claims = await verifyRequest(requestWithHeader(preset.header, token), {
      preset,
      aud: AUD,
      keySet: keySet(),
    });
    expect(claims?.sub).toBe('user-7');
  });

  it('returns undefined and does NOT call onError when no token is present', async () => {
    await setup();
    let called = false;
    const claims = await verifyRequest(new Request('https://app.example.com/'), {
      preset,
      aud: AUD,
      keySet: keySet(),
      onError: () => {
        called = true;
      },
    });
    expect(claims).toBeUndefined();
    expect(called).toBe(false);
  });

  it('returns undefined and DOES call onError for a present-but-invalid token', async () => {
    await setup();
    const token = await mintToken({
      privateKey: keys.privateKey,
      issuer: preset.issuer,
      audience: AUD,
    });
    let observed: unknown;
    const claims = await verifyRequest(requestWithHeader(preset.header, tamperSignature(token)), {
      preset,
      aud: AUD,
      keySet: keySet(),
      onError: (error) => {
        observed = error;
      },
    });
    expect(claims).toBeUndefined();
    expect(observed).toBeInstanceOf(Error);
  });

  it('swallows an onError observer throw and still fails closed', async () => {
    await setup();
    const token = await mintToken({
      privateKey: keys.privateKey,
      issuer: preset.issuer,
      audience: AUD,
    });
    const claims = await verifyRequest(requestWithHeader(preset.header, tamperSignature(token)), {
      preset,
      aud: AUD,
      keySet: keySet(),
      onError: () => {
        throw new Error('observer blew up');
      },
    });
    expect(claims).toBeUndefined();
  });
});
