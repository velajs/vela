import { beforeAll, describe, expect, it } from 'vitest';
import { cloudflareAccessIssuer } from '../issuer';
import { composeResolvers, createAccessResolver } from '../resolver';
import type { ResolvedIdentity, ResolveIdentity } from '../types';
import { makeKeyMaterial, mintToken, requestWithHeader, type TestKeyMaterial } from './harness';

const preset = cloudflareAccessIssuer('acme');
const AUD = 'app-audience-tag';

let keys: TestKeyMaterial;
beforeAll(async () => {
  keys = await makeKeyMaterial();
});

const tokenRequest = (claims: Record<string, unknown>, subject?: string): Promise<string> =>
  mintToken({
    privateKey: keys.privateKey,
    kid: keys.kid,
    issuer: preset.issuer,
    audience: AUD,
    ...(subject === undefined ? {} : { subject }),
    claims,
  });

const resolver = (): ReturnType<typeof createAccessResolver> =>
  createAccessResolver({ preset, aud: AUD, keySet: keys.jwks });

describe('createAccessResolver', () => {
  it('maps a verified token to a ResolvedIdentity, forwarding groups/email/exp/claims', async () => {
    const token = await tokenRequest({ email: 'ada@example.com', groups: ['admins'] }, 'user-42');
    const identity = await resolver()(requestWithHeader(preset.header, token));

    expect(identity).not.toBeNull();
    expect(identity?.userId).toBe('user-42');
    expect(identity?.email).toBe('ada@example.com');
    expect(identity?.groups).toEqual(['admins']);
    expect(typeof identity?.exp).toBe('number');
    expect(identity?.claims.iss).toBe(preset.issuer);
  });

  it('derives userId from sub, then email, then common_name', async () => {
    const bySub = await resolver()(
      requestWithHeader(preset.header, await tokenRequest({}, 'sub-1')),
    );
    expect(bySub?.userId).toBe('sub-1');

    const byEmail = await resolver()(
      requestWithHeader(preset.header, await tokenRequest({ email: 'ada@example.com' })),
    );
    expect(byEmail?.userId).toBe('ada@example.com');

    const byCommonName = await resolver()(
      requestWithHeader(preset.header, await tokenRequest({ common_name: 'svc-token' })),
    );
    expect(byCommonName?.userId).toBe('svc-token');
    expect(byCommonName?.commonName).toBe('svc-token');
  });

  it('resolves to anonymous (null) for a missing or invalid token', async () => {
    expect(await resolver()(new Request('https://app.example.com/'))).toBeNull();
    expect(await resolver()(requestWithHeader(preset.header, 'not-a-jwt'))).toBeNull();
  });

  it('applies mapClaims overrides and can override the derived userId', async () => {
    const custom = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      mapClaims: (claims) => ({ userId: `tenant:${String(claims.sub)}`, tenantId: 't-9' }),
    });
    const identity = await custom(
      requestWithHeader(preset.header, await tokenRequest({}, 'user-42')),
    );
    expect(identity?.userId).toBe('tenant:user-42');
    expect(identity?.tenantId).toBe('t-9');
  });

  it('fails fast at build time on an empty audience (no silent-anonymous)', () => {
    expect(() => createAccessResolver({ preset, aud: '', keySet: keys.jwks })).toThrow(
      /audience is mandatory/,
    );
  });
});

describe('composeResolvers', () => {
  const hit: ResolvedIdentity = { userId: 'from-second', claims: {} };
  const anon: ResolveIdentity = () => null;
  const found: ResolveIdentity = () => hit;

  it('returns the first non-null identity in order', async () => {
    const composed = composeResolvers(anon, found);
    expect(await composed(new Request('https://app.example.com/'))).toBe(hit);
  });

  it('resolves to null when every resolver is anonymous', async () => {
    const composed = composeResolvers(anon, anon);
    expect(await composed(new Request('https://app.example.com/'))).toBeNull();
  });

  it('short-circuits — a later resolver is not consulted after a hit', async () => {
    let laterCalled = false;
    const later: ResolveIdentity = () => {
      laterCalled = true;
      return null;
    };
    const composed = composeResolvers(found, later);
    await composed(new Request('https://app.example.com/'));
    expect(laterCalled).toBe(false);
  });
});
