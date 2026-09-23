import { expect, it, vi } from 'vitest';
import {
  Controller,
  Get,
  Module,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import { setTrustedRequestIdentity } from '@velajs/vela/module-kit';
import { MemoryTenantRegistryStore, TenantRegistry } from '../../packages/tenant/src/index';
import {
  TenantGuard,
  TenantModule,
  TENANT_CONTEXT_READER,
} from '../../packages/tenant/src/vela/index';
import {
  CedarGuard,
  CedarModule,
  RequireResource,
} from '../../packages/authz-cedar/src/vela/index';

it('orders route authentication, tenant admission and Cedar authorization without publishing selectors as authority', async () => {
  const principal = { issuer: 'test', subject: 'alice', principalType: 'user' } as const;
  const tenant = { id: 'a', name: 'A', status: 'active' as const, revision: 1, settings: {} };
  const store = new MemoryTenantRegistryStore([tenant]);
  const authorized = vi.fn();
  class AuthenticationGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      if (context.getRequest().headers.get('x-auth') !== 'verified') return false;
      setTrustedRequestIdentity(context.getRequest(), { principal });
      return true;
    }
  }
  class Routes {
    read() {
      return { ok: true };
    }
  }
  Controller('/docs')(Routes);
  UseGuards(AuthenticationGuard, TenantGuard, CedarGuard)(Routes);
  Get('/:id')(Routes.prototype, 'read', Object.getOwnPropertyDescriptor(Routes.prototype, 'read')!);
  RequireResource({ action: 'read', resourceType: 'Doc', idParam: 'id' })(Routes);
  class App {}
  Module({
    controllers: [Routes],
    imports: [
      TenantModule.forRoot({
        lookup: store,
        authorize: ({ principal }) => principal.subject === 'alice',
      }),
      CedarModule.forRoot({
        globalGuard: false,
        auditModules: [App],
        authorize: async ({ context, identity }) => {
          const tenant = context
            .getContainer()!
            .resolve(TENANT_CONTEXT_READER, context.getModuleId())
            .requireTenant();
          expect(identity.tenantId).toBe(tenant.id);
          expect(tenant.authority).toBe('tenant');
          authorized();
          return tenant.id === 'a';
        },
      }),
    ],
  })(App);
  const app = await VelaFactory.create(App);
  const headers = { 'x-auth': 'verified', 'x-tenant-id': 'a' };
  try {
    expect((await app.getHonoApp().request('/docs/1', { headers })).status).toBe(200);
    expect(authorized).toHaveBeenCalledOnce();
    expect(
      (await app.getHonoApp().request('/docs/1', { headers: { 'x-tenant-id': 'a' } })).status,
    ).toBe(403);
    expect(
      (
        await app
          .getHonoApp()
          .request('/docs/1', { headers: { ...headers, 'x-tenant-id': 'forged' } })
      ).status,
    ).toBe(403);
    await new TenantRegistry({ store, authorize: () => true }).save(
      { ...tenant, status: 'suspended' },
      1,
      principal,
      'Suspend tenant',
    );
    expect((await app.getHonoApp().request('/docs/1', { headers })).status).toBe(403);
    expect(authorized).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
