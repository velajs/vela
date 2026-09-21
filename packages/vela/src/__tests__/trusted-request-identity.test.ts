import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearTrustedRequestIdentity,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  setTrustedRequestTenant,
  createTrustedRequestIdentityStore,
  bindTrustedRequestContext,
  getTrustedContextRequest,
} from '../http/trusted-request-identity';
import { buildEntrypointExecutionContext } from '../entrypoint/execution-context';

const principal = { issuer: 'accounts', subject: 'user-1', principalType: 'user' } as const;
afterEach(() => vi.useRealTimers());

describe('trusted request identity', () => {
  it('binds custom contexts explicitly without trusting arbitrary HTTP accessors or rebinding', () => {
    class Handler {}
    let request = new Request('https://test.invalid');
    const context = {
      ...buildEntrypointExecutionContext('graphql', Handler, 'read', {}),
      getRequest: () => request,
    };
    expect(getTrustedContextRequest(context)).toBeUndefined();
    bindTrustedRequestContext(context, request);
    expect(getTrustedContextRequest(context)).toBe(request);
    bindTrustedRequestContext(context, request);
    const original = request;
    request = new Request('https://other.invalid');
    expect(() => bindTrustedRequestContext(context, request)).toThrow(/HTTP-backed/);
    expect(getTrustedContextRequest(context)).toBe(original);
    expect(() => bindTrustedRequestContext({ ...context, getType: () => 'ws' }, request)).toThrow();
  });

  it('keeps independent provider payloads through tenant admission but invalidates replacements', () => {
    const request = new Request('https://test.invalid');
    const otherRequest = new Request(request);
    const first = createTrustedRequestIdentityStore<string>();
    const second = createTrustedRequestIdentityStore<number>();
    expect(() => first.set(request, 'payload')).toThrow(/live identity/);
    setTrustedRequestIdentity(request, { principal, roles: ['reader'] });
    const original = getTrustedRequestIdentity(request)!;
    first.set(request, 'payload');
    second.set(request, 123);
    const admitted = setTrustedRequestTenant(request, original, 'tenant-1');
    expect(admitted).toEqual({ ...original, tenantId: 'tenant-1' });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(original.tenantId).toBeUndefined();
    expect(first.get(request)).toBe('payload');
    expect(second.get(request)).toBe(123);
    expect(first.get(otherRequest)).toBeUndefined();
    expect(setTrustedRequestTenant(request, admitted, 'tenant-1')).toBe(admitted);
    expect(() => setTrustedRequestTenant(request, original, 'tenant-1')).toThrow(/current/);
    expect(() => setTrustedRequestTenant(request, admitted, 'tenant-2')).toThrow(/bound tenant/);
    expect(() => setTrustedRequestTenant(request, admitted, '')).toThrow(/tenantId/);
    expect(getTrustedRequestIdentity(request)).toBe(admitted);
    setTrustedRequestIdentity(request, admitted);
    expect(first.get(request)).toBeUndefined();
    expect(second.get(request)).toBeUndefined();
    first.set(request, 'new');
    clearTrustedRequestIdentity(request);
    expect(first.get(request)).toBeUndefined();
  });

  it('cannot enrich or recover payload from expired or failed authentication', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const request = new Request('https://test.invalid');
    const payload = createTrustedRequestIdentityStore<string>();
    setTrustedRequestIdentity(request, { principal, expiresAtMs: 2000 });
    const original = getTrustedRequestIdentity(request)!;
    payload.set(request, 'secret');
    setTrustedRequestTenant(request, original, 'tenant-1');
    vi.setSystemTime(2000);
    expect(payload.get(request)).toBeUndefined();
    expect(() => setTrustedRequestTenant(request, original, 'tenant-1')).toThrow(/live identity/);
    vi.setSystemTime(1000);
    expect(payload.get(request)).toBeUndefined();
    setTrustedRequestIdentity(request, { principal });
    payload.set(request, 'new');
    expect(() => setTrustedRequestIdentity(request, { principal, expiresAtMs: 0 })).toThrow();
    expect(payload.get(request)).toBeUndefined();
  });

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
