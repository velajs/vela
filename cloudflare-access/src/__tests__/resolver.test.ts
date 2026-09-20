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
  it('maps a verified token to a stable principal with canonical millisecond expiry', async () => {
    const token = await tokenRequest({ email: 'ada@example.com', groups: ['admins'] }, 'user-42');
    const identity = await resolver()(requestWithHeader(preset.header, token));

    expect(identity).not.toBeNull();
    expect(identity?.issuer).toBe(preset.issuer);
    expect(identity?.subject).toBe('user-42');
    expect(identity?.principalType).toBe('user');
    expect(identity?.userId).toBe('user-42');
    expect(identity?.email).toBe('ada@example.com');
    expect(identity?.groups).toEqual(['admins']);
    expect(Number.isSafeInteger(identity?.expiresAtMs)).toBe(true);
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

  it('allows mapClaims enrichment without changing verified principal fields', async () => {
    const custom = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      mapClaims: () => ({ displayLabel: 'Ada' }),
    });
    const identity = await custom(
      requestWithHeader(preset.header, await tokenRequest({}, 'user-42')),
    );
    expect(identity?.userId).toBe('user-42');
    expect(identity?.displayLabel).toBe('Ada');
  });

  it.each([
    'tenantId',
    'userId',
    'subject',
    'issuer',
    'principalType',
    'expiresAtMs',
    'roles',
    'email',
    '__proto__',
  ])('rejects mapClaims attempts to replace security field %s', async (field) => {
    const custom = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      mapClaims: () => ({ [field]: 'attacker-controlled' }),
    });
    await expect(
      custom(requestWithHeader(preset.header, await tokenRequest({}, 'user-42'))),
    ).rejects.toThrow(/cannot replace verified security field/);
  });

  it('prevents mapClaims from mutating verified subject, expiry, or groups in place', async () => {
    const custom = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      groupRoles: { editor: 'editor', admin: 'admin' },
      mapClaims: (claims) => {
        claims.sub = 'attacker';
        claims.exp = Number(claims.exp) + 86_400;
        claims.groups = ['admin'];
        return { displayLabel: 'Ada' };
      },
    });
    const identity = await custom(
      requestWithHeader(preset.header, await tokenRequest({ groups: ['editor'] }, 'user-42')),
    );
    expect(identity?.subject).toBe('user-42');
    expect(identity?.roles).toEqual(['editor']);
    expect(identity?.expiresAtMs).toBe(Number(identity?.claims.exp) * 1000);
  });

  it('maps external groups to local roles only through an explicit allowlist', async () => {
    const token = await tokenRequest({ groups: ['idp-admin', 'unmapped', '__proto__'] }, 'user-42');
    const withoutMapping = await resolver()(requestWithHeader(preset.header, token));
    expect(withoutMapping?.roles).toBeUndefined();

    const mapped = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      groupRoles: { 'idp-admin': ['editor', 'auditor'] },
    });
    expect((await mapped(requestWithHeader(preset.header, token)))?.roles).toEqual([
      'editor',
      'auditor',
    ]);
  });

  it('fails fast at build time on an empty audience (no silent-anonymous)', () => {
    expect(() => createAccessResolver({ preset, aud: '', keySet: keys.jwks })).toThrow(
      /audience is mandatory/,
    );
  });
});

describe('composeResolvers', () => {
  const hit: ResolvedIdentity = {
    issuer: 'https://issuer.example',
    subject: 'from-second',
    principalType: 'user',
    userId: 'from-second',
    expiresAtMs: Date.now() + 60_000,
    claims: {},
  };
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

describe('verified tenant mapping', () => {
  it('selects tenant membership only from the configured signed claim', async () => {
    const resolve = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      tenantClaim: 'organization',
    });
    const request = requestWithHeader(
      preset.header,
      await tokenRequest({ organization: 'tenant-9' }, 'user-1'),
    );
    expect(await resolve(request)).toMatchObject({ tenantId: 'tenant-9', subject: 'user-1' });
  });

  it('rejects malformed optional fields rather than claiming a typed AccessClaims value', async () => {
    for (const claims of [
      { email: 42 },
      { groups: ['editor', 42] },
      { common_name: {} },
      { sub: 42, email: 'valid@example.com' },
      { jti: 42, email: 'valid@example.com' },
    ]) {
      const request = requestWithHeader(preset.header, await tokenRequest(claims));
      expect(await resolver()(request)).toBeNull();
    }
  });
});
