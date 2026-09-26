import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from '../container/container';
import { buildEntrypointExecutionContext } from '../entrypoint/execution-context';
import {
  createExecutionScope,
  EXECUTION_LIFETIME,
  runInEntrypointScope,
} from '../entrypoint/execution-scope';
import {
  bindTrustedRequestContext,
  clearTrustedContextIdentity,
  getTrustedContextIdentity,
  getTrustedRequestIdentity,
  setTrustedContextIdentity,
  setTrustedContextTenant,
  setTrustedRequestIdentity,
  type TrustedRequestIdentity,
} from '../http/trusted-request-identity';

class Handler {
  call() {}
}
const context = (container?: Container) =>
  buildEntrypointExecutionContext(
    'rpc',
    Handler,
    'call',
    { subject: 'forged' },
    undefined,
    container,
  );
const identity = (subject = 'alice'): TrustedRequestIdentity => ({
  principal: { issuer: 'accounts', subject, principalType: 'user' },
  roles: ['reader'],
  claims: { nested: { values: ['verified'] } },
});
afterEach(() => vi.restoreAllMocks());

describe('canonical context identity', () => {
  it('isolates concurrent, sibling, nested and independent application scopes while sharing aliases', async () => {
    const root = new Container();
    const first = createExecutionScope(root);
    const sibling = createExecutionScope(root);
    const nested = createExecutionScope(first.container);
    const other = createExecutionScope(new Container());
    const ctx = context(first.container);
    setTrustedContextIdentity(ctx, identity());
    const snapshot = getTrustedContextIdentity(ctx);
    expect(getTrustedContextIdentity(context(first.container))).toBe(snapshot);
    for (const scope of [sibling, nested, other]) {
      expect(getTrustedContextIdentity(context(scope.container))).toBeUndefined();
      setTrustedContextIdentity(context(scope.container), identity(scope.lifetime.id));
    }
    expect(getTrustedContextIdentity(ctx)).toBe(snapshot);
    expect(() => ctx.getRequest()).toThrow('entrypoint');
    expect(() => ctx.getContext()).toThrow('entrypoint');
    await Promise.all([first.finish(), sibling.finish(), nested.finish(), other.finish()]);
    expect(getTrustedContextIdentity(ctx)).toBeUndefined();
  });

  it('delegates HTTP and explicitly bound contexts to request authority and attachments', () => {
    const request = new Request('https://example.test');
    const http = { ...context(), getType: () => 'http', getRequest: () => request };
    const bound = { ...http, getType: () => 'graphql' };
    bindTrustedRequestContext(bound, request);
    setTrustedContextIdentity(bound, identity());
    expect(getTrustedContextIdentity(http)).toBe(getTrustedRequestIdentity(request));
    expect(getTrustedContextIdentity(bound)).toBe(getTrustedContextIdentity(http));
    const enriched = setTrustedContextTenant(bound, getTrustedContextIdentity(http)!, 'tenant-a');
    expect(getTrustedRequestIdentity(request)).toBe(enriched);
    clearTrustedContextIdentity(http);
    expect(getTrustedContextIdentity(bound)).toBeUndefined();
    setTrustedRequestIdentity(request, identity());
    expect(getTrustedContextIdentity(bound)).toBe(getTrustedRequestIdentity(request));
  });

  it('rejects root, unmanaged, forged lifetime, missing and completed scopes', async () => {
    const root = new Container();
    const unmanaged = root.createChild();
    const managed = createExecutionScope(root);
    unmanaged.setRequestInstance(EXECUTION_LIFETIME, managed.lifetime);
    for (const ctx of [context(), context(root), context(unmanaged)]) {
      expect(() => setTrustedContextIdentity(ctx, identity())).toThrow('live managed invocation');
      expect(getTrustedContextIdentity(ctx)).toBeUndefined();
    }
    await managed.finish();
    Object.defineProperty(managed.lifetime, 'active', { value: true });
    expect(getTrustedContextIdentity(context(managed.container))).toBeUndefined();
    expect(() => managed.lifetime.defer(() => {})).toThrow('closed');
    expect(() => setTrustedContextIdentity(context(managed.container), identity())).toThrow(
      'live managed invocation',
    );
  });

  it('takes recursively frozen snapshots, rejects inherited/accessor claims and clears failed replacement', async () => {
    const scope = createExecutionScope(new Container());
    const ctx = context(scope.container);
    const input = identity();
    setTrustedContextIdentity(ctx, input);
    const value = getTrustedContextIdentity(ctx)!;
    expect(value).not.toBe(input);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.principal)).toBe(true);
    expect(Object.isFrozen(value.roles)).toBe(true);
    expect(Object.isFrozen(value.claims?.nested)).toBe(true);
    const accessor = vi.fn(() => 'alice');
    for (const invalid of [
      Object.create(input),
      {
        ...input,
        principal: {
          ...input.principal,
          get subject() {
            return accessor();
          },
        },
      },
      { ...input, claims: { executable: () => 'no' } },
      { ...input, expiresAtMs: Date.now() - 1 },
    ]) {
      setTrustedContextIdentity(ctx, input);
      expect(() => setTrustedContextIdentity(ctx, invalid)).toThrow();
      expect(getTrustedContextIdentity(ctx)).toBeUndefined();
    }
    expect(accessor).not.toHaveBeenCalled();
    await scope.finish();
  });

  it('makes observed expiry irreversible and rejects stale tenant admission after clear/replacement', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const scope = createExecutionScope(new Container());
    const ctx = context(scope.container);
    setTrustedContextIdentity(ctx, { ...identity(), expiresAtMs: 2000 });
    const old = getTrustedContextIdentity(ctx)!;
    time.mockReturnValue(2000);
    expect(getTrustedContextIdentity(ctx)).toBeUndefined();
    time.mockReturnValue(1000);
    expect(getTrustedContextIdentity(ctx)).toBeUndefined();
    expect(() => setTrustedContextTenant(ctx, old, 'tenant-a')).toThrow('current live identity');
    for (const invalidate of [
      () => clearTrustedContextIdentity(ctx),
      () => setTrustedContextIdentity(ctx, identity()),
    ]) {
      setTrustedContextIdentity(ctx, identity());
      const expected = getTrustedContextIdentity(ctx)!;
      invalidate();
      expect(() => setTrustedContextTenant(ctx, expected, 'tenant-a')).toThrow(
        'current live identity',
      );
    }
    const current = getTrustedContextIdentity(ctx)!;
    const admitted = setTrustedContextTenant(ctx, current, 'tenant-a');
    expect(admitted.principal).toBe(current.principal);
    expect(admitted.claims).toBe(current.claims);
    expect(() => setTrustedContextTenant(ctx, current, 'tenant-b')).toThrow(
      'current live identity',
    );
    expect(() => setTrustedContextTenant(ctx, admitted, 'tenant-b')).toThrow('bound tenant');
    expect(setTrustedContextTenant(ctx, admitted, 'tenant-a')).toBe(admitted);
    await scope.finish();
  });

  it('retains authority through managed work, then invalidates on completion or handler failure', async () => {
    for (const fail of [false, true]) {
      let retained: ReturnType<typeof context> | undefined;
      const result = runInEntrypointScope(new Container(), (container, lifetime) => {
        const ctx = context(container);
        retained = ctx;
        setTrustedContextIdentity(ctx, identity());
        const expected = getTrustedContextIdentity(ctx);
        lifetime.defer(async () => {
          await Promise.resolve();
          expect(getTrustedContextIdentity(ctx)).toBe(expected);
          lifetime.defer(() => expect(getTrustedContextIdentity(ctx)).toBe(expected));
        });
        if (fail) throw new Error('handler failed');
      });
      if (fail) await expect(result).rejects.toThrow('handler failed');
      else await result;
      expect(getTrustedContextIdentity(retained!)).toBeUndefined();
    }
  });

  it('invalidates synchronously at direct scope or root disposal, including pending deferred work', async () => {
    for (const disposeRoot of [false, true]) {
      const root = new Container();
      const scope = createExecutionScope(root);
      const ctx = context(scope.container);
      setTrustedContextIdentity(ctx, identity());
      scope.lifetime.defer(() => expect(getTrustedContextIdentity(ctx)).toBeUndefined());
      const disposal = (disposeRoot ? root : scope.container).dispose();
      expect(scope.lifetime.active).toBe(false);
      Object.defineProperty(scope.lifetime, 'active', { value: true });
      expect(getTrustedContextIdentity(ctx)).toBeUndefined();
      expect(() => scope.lifetime.defer(() => {})).toThrow('closed');
      expect(() => setTrustedContextIdentity(ctx, identity())).toThrow('live managed invocation');
      await disposal;
      await scope.finish();
    }
  });
});
