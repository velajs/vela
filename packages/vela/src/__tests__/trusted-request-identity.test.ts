import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearTrustedRequestIdentity,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
} from '../http/trusted-request-identity';

const principal = { issuer: 'accounts', subject: 'user-1', principalType: 'user' } as const;
afterEach(() => vi.useRealTimers());

describe('trusted request identity', () => {
  it('snapshots principal, roles and nested claims without aliases', () => {
    const request = new Request('https://test.invalid');
    const roles = ['editor'];
    const claims = { scope: { actions: ['write'] } };
    setTrustedRequestIdentity(request, { principal, roles, claims, tenantId: 'tenant-1' });
    roles.push('admin');
    claims.scope.actions.push('delete');
    const identity = getTrustedRequestIdentity(request);
    expect(identity).toEqual({
      principal,
      roles: ['editor'],
      claims: { scope: { actions: ['write'] } },
      tenantId: 'tenant-1',
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity?.roles)).toBe(true);
    expect(Object.isFrozen(identity?.claims?.scope)).toBe(true);
  });

  it('expires at the exclusive millisecond boundary and cannot revive if the clock moves back', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const request = new Request('https://test.invalid');
    setTrustedRequestIdentity(request, { principal, expiresAtMs: 2000 });
    vi.setSystemTime(1999);
    expect(getTrustedRequestIdentity(request)).toBeDefined();
    vi.setSystemTime(2000);
    expect(getTrustedRequestIdentity(request)).toBeUndefined();
    vi.setSystemTime(1000);
    expect(getTrustedRequestIdentity(request)).toBeUndefined();
  });

  it('clears stale state when replacement publication rejects', () => {
    const request = new Request('https://test.invalid');
    setTrustedRequestIdentity(request, { principal });
    expect(() => setTrustedRequestIdentity(request, { principal, expiresAtMs: 0 })).toThrow();
    expect(getTrustedRequestIdentity(request)).toBeUndefined();
    setTrustedRequestIdentity(request, { principal });
    clearTrustedRequestIdentity(request);
    expect(getTrustedRequestIdentity(request)).toBeUndefined();
  });

  it('never invokes authority or claim getters', () => {
    const getter = vi.fn(() => 'attacker');
    const request = new Request('https://test.invalid');
    const claims = Object.defineProperty({}, 'role', { get: getter, enumerable: true });
    expect(() => setTrustedRequestIdentity(request, { principal, claims })).toThrow(
      /own data property/,
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects cyclic and non-JSON claims', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const request = new Request('https://test.invalid');
    expect(() => setTrustedRequestIdentity(request, { principal, claims: cycle })).toThrow(/JSON/);
    expect(() =>
      setTrustedRequestIdentity(request, { principal, claims: { date: new Date() } }),
    ).toThrow(/plain objects/);
  });
});
