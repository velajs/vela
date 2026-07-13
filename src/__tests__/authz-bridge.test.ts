import { createAuthz } from '@velajs/authz';
import { createAccessControl } from 'better-auth/plugins/access';
import { describe, expect, it } from 'vitest';
import { betterAuthAcResolver, identityFromUser } from '../authz-bridge';

describe('identityFromUser', () => {
  it('maps a better-auth user id + single role to an Identity', () => {
    // Input is cast: a real better-auth `User` carries many required fields
    // (email, emailVerified, createdAt, …) irrelevant to this mapping. The
    // exported signature is typed against `User`; the mapping is dogfooded by
    // the return-value assertions below, not the fixture's compile-time shape.
    const id = identityFromUser({ id: 'u1', role: 'admin' } as never);
    expect(id).toEqual({ userId: 'u1', roles: ['admin'] });
  });

  it('splits a comma-separated role string into roles', () => {
    const id = identityFromUser({ id: 'u2', role: 'admin, editor ,viewer' } as never);
    expect(id).toEqual({ userId: 'u2', roles: ['admin', 'editor', 'viewer'] });
  });

  it('accepts a role array as-is', () => {
    const id = identityFromUser({ id: 'u3', role: ['admin', 'editor'] } as never);
    expect(id).toEqual({ userId: 'u3', roles: ['admin', 'editor'] });
  });

  it('yields empty roles when the user has no role field', () => {
    const id = identityFromUser({ id: 'u4' } as never);
    expect(id).toEqual({ userId: 'u4', roles: [] });
  });

  it('fail-closed: a missing user maps to the zero-privilege identity', () => {
    expect(identityFromUser(null)).toEqual({ roles: [] });
    expect(identityFromUser(undefined)).toEqual({ roles: [] });
  });
});

describe('betterAuthAcResolver', () => {
  const ac = createAccessControl({
    posts: ['read', 'write', 'delete'],
    users: ['ban'],
  });
  const editor = ac.newRole({ posts: ['read', 'write'] });
  const admin = ac.newRole({ posts: ['read', 'write', 'delete'], users: ['ban'] });

  it('flattens an AC role table into resource:action permission grants', () => {
    const resolver = betterAuthAcResolver({ editor, admin });
    expect(resolver.grants({ roles: ['editor'] })).toEqual(new Set(['posts:read', 'posts:write']));
  });

  it('unions grants across an identity with multiple roles', () => {
    const resolver = betterAuthAcResolver({ editor, admin });
    expect(resolver.grants({ roles: ['editor', 'admin'] })).toEqual(
      new Set(['posts:read', 'posts:write', 'posts:delete', 'users:ban']),
    );
  });

  it('fail-closed: unknown roles and empty identities grant nothing', () => {
    const resolver = betterAuthAcResolver({ editor, admin });
    expect(resolver.grants({ roles: ['ghost'] })).toEqual(new Set());
    expect(resolver.grants({})).toEqual(new Set());
  });

  it('drives @velajs/authz can() as the resolver', async () => {
    const authz = createAuthz({ resolver: betterAuthAcResolver({ editor, admin }) });
    expect(await authz.can({ roles: ['editor'] }, 'posts:write')).toBe(true);
    expect(await authz.can({ roles: ['editor'] }, 'posts:delete')).toBe(false);
    expect(await authz.can({ roles: ['admin'] }, 'users:ban')).toBe(true);
    expect(await authz.can({ roles: [] }, 'posts:read')).toBe(false);
  });
});
