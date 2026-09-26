import { describe, expect, it, vi } from 'vitest';
import { Module, Reflector, VelaFactory } from '@velajs/vela';
import {
  createExecutionScope,
  buildEntrypointExecutionContext,
  setTrustedContextIdentity,
  getTrustedContextIdentity,
  clearTrustedContextIdentity,
} from '@velajs/vela/module-kit';
import { MemoryTenantRegistryStore } from '../index';
import { TenantModule, TenantGuard, TenantOptional, TENANT_CONTEXT_READER } from '../vela/index';
const principal = { issuer: 'accounts', subject: 'alice', principalType: 'user' } as const;
const registry = () =>
  new MemoryTenantRegistryStore([
    { id: 'a', name: 'A', status: 'active', revision: 1, settings: {} },
  ]);

describe('canonical native tenant admission', () => {
  it.each(['valid', 'clear', 'replace', 'expire', 'dispose'] as const)(
    'enriches only the original live snapshot: %s',
    async (mode) => {
      class Native {
        read() {}
      }
      let invalidate = () => {};
      const admit = vi.fn(async () => {
        await Promise.resolve();
        invalidate();
        return true;
      });
      class App {}
      Module({
        providers: [Native],
        imports: [
          TenantModule.forRoot({
            lookup: registry(),
            authorize: admit,
            resolve: () => ({ tenantId: 'a', principal, source: 'rpc' }),
          }),
        ],
      })(App);
      const app = await VelaFactory.createApplicationContext(App);
      const root = app.getContainer();
      const scope = createExecutionScope(root);
      const moduleId = root.getOwnerModuleIds(Native)[0]!;
      const ctx = buildEntrypointExecutionContext(
        'rpc',
        Native,
        'read',
        [],
        moduleId,
        scope.container,
      );
      let now = 1000;
      const time = vi.spyOn(Date, 'now').mockImplementation(() => now);
      setTrustedContextIdentity(ctx, { principal, expiresAtMs: 2000 });
      const original = getTrustedContextIdentity(ctx)!;
      invalidate = () => {
        if (mode === 'clear') clearTrustedContextIdentity(ctx);
        if (mode === 'replace') setTrustedContextIdentity(ctx, original);
        if (mode === 'expire') now = 2000;
        if (mode === 'dispose') void scope.container.dispose();
      };
      try {
        const pending = new TenantGuard(new Reflector()).canActivate(ctx);
        if (mode === 'valid') {
          await expect(pending).resolves.toBe(true);
          expect(getTrustedContextIdentity(ctx)).toMatchObject({ tenantId: 'a', principal });
          const reader = scope.container.resolve(TENANT_CONTEXT_READER, moduleId);
          expect(reader.requireTenantId()).toBe('a');
          time.mockReturnValueOnce(1999).mockReturnValueOnce(2000).mockReturnValue(1000);
          // Canonical states use one expiry check per read. A second local
          // clock read must not observe expiry without revoking core authority.
          expect(reader.current()?.id).toBe('a');
          expect(reader.current()).toBeUndefined();
          expect(reader.current()).toBeUndefined();
          clearTrustedContextIdentity(ctx);
          expect(reader.current()).toBeUndefined();
        } else
          await expect(pending).rejects.toThrow(
            mode === 'expire' ? 'Tenant access denied' : 'Identity changed',
          );
      } finally {
        time.mockRestore();
        await scope.finish();
        await app.close();
      }
    },
  );

  it('binds the returned snapshot and canonical expiry when the clock crosses expiry during publication', async () => {
    class Native {
      read() {}
    }
    class App {}
    Module({
      providers: [Native],
      imports: [
        TenantModule.forRoot({
          lookup: registry(),
          authorize: () => true,
          // This selector omits expiry; it cannot extend canonical credentials.
          resolve: () => ({ tenantId: 'a', principal }),
        }),
      ],
    })(App);
    const app = await VelaFactory.createApplicationContext(App);
    const root = app.getContainer();
    const scope = createExecutionScope(root);
    const moduleId = root.getOwnerModuleIds(Native)[0]!;
    const ctx = buildEntrypointExecutionContext(
      'rpc',
      Native,
      'read',
      [],
      moduleId,
      scope.container,
    );
    let now = 1000;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => now);
    setTrustedContextIdentity(ctx, { principal, expiresAtMs: 2000 });
    const original = getTrustedContextIdentity(ctx)!;
    const freeze = Object.freeze;
    const freezing = vi.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = freeze(value);
      if (
        typeof value === 'object' &&
        value !== null &&
        Reflect.get(value, 'principal') === original.principal &&
        Reflect.get(value, 'tenantId') === 'a'
      )
        now = 2000;
      return result;
    });
    try {
      await expect(new TenantGuard(new Reflector()).canActivate(ctx)).resolves.toBe(true);
      const reader = scope.container.resolve(TENANT_CONTEXT_READER, moduleId);
      expect(reader.current()).toBeUndefined();
      now = 1000;
      expect(reader.current()).toBeUndefined();
      expect(getTrustedContextIdentity(ctx)).toBeUndefined();
    } finally {
      freezing.mockRestore();
      time.mockRestore();
      await scope.finish();
      await app.close();
    }
  });

  it('allows exactly one concurrent tenant CAS and rejects an alternate principal without admission', async () => {
    class Native {
      read() {}
    }
    let forged = false;
    const admitted = vi.fn(async () => true);
    class App {}
    Module({
      providers: [Native],
      imports: [
        TenantModule.forRoot({
          lookup: registry(),
          authorize: admitted,
          resolve: () => ({
            tenantId: 'a',
            principal: forged ? { ...principal, subject: 'mallory' } : principal,
          }),
        }),
      ],
    })(App);
    const app = await VelaFactory.createApplicationContext(App);
    const root = app.getContainer();
    const scope = createExecutionScope(root);
    const ctx = buildEntrypointExecutionContext(
      'rpc',
      Native,
      'read',
      [],
      root.getOwnerModuleIds(Native)[0],
      scope.container,
    );
    try {
      setTrustedContextIdentity(ctx, { principal });
      const guard = new TenantGuard(new Reflector());
      const outcomes = await Promise.allSettled([guard.canActivate(ctx), guard.canActivate(ctx)]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      admitted.mockClear();
      forged = true;
      await expect(guard.canActivate(ctx)).rejects.toThrow('Conflicting tenant principal');
      expect(admitted).not.toHaveBeenCalled();
    } finally {
      await scope.finish();
      await app.close();
    }
  });

  it.each(['http', 'rpc'] as const)(
    'optional %s denies explicit selection without canonical identity',
    async (kind) => {
      class Native {
        read() {}
      }
      TenantOptional()(Native);
      let selected = false;
      const admitted = vi.fn(() => true);
      class App {}
      Module({
        providers: [Native],
        imports: [
          TenantModule.forRoot({
            lookup: registry(),
            authorize: admitted,
            resolve: () => (selected ? { tenantId: 'a', principal } : undefined),
          }),
        ],
      })(App);
      const app = await VelaFactory.createApplicationContext(App);
      const root = app.getContainer();
      const scope = createExecutionScope(root);
      const native = buildEntrypointExecutionContext(
        'rpc',
        Native,
        'read',
        [],
        root.getOwnerModuleIds(Native)[0],
        scope.container,
      );
      // Explicitly bound adapters exercise HTTP request authority without creating a fake native request.
      const request = new Request('https://example.test');
      const ctx =
        kind === 'http'
          ? { ...native, getType: () => 'graphql', getRequest: () => request }
          : native;
      if (kind === 'http') {
        const { bindTrustedRequestContext } = await import('@velajs/vela/module-kit');
        bindTrustedRequestContext(ctx, request);
      }
      try {
        const guard = new TenantGuard(new Reflector());
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        selected = true;
        await expect(guard.canActivate(ctx)).rejects.toThrow('authenticated identity');
        expect(admitted).not.toHaveBeenCalled();
        setTrustedContextIdentity(ctx, { principal });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      } finally {
        await scope.finish();
        await app.close();
      }
    },
  );
});
