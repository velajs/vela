import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CrudModule, defineCrudFeature, defineModel } from '@velajs/crud';
import { MemoryStore, memoryAdapter } from '@velajs/crud-memory';
import {
  APP_GUARD,
  Controller,
  Get,
  Module,
  UseGuards,
  VelaFactory,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
  type GuardPhase,
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
  CedarPublic,
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
      // A fully route-level pipeline: no module installs its global guard.
      TenantModule.forRoot({
        lookup: store,
        authorize: ({ principal }) => principal.subject === 'alice',
      }),
      CedarModule.forRoot({
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

it('orders global authentication, tenant admission and Cedar authorization by phase', async () => {
  const principal = { issuer: 'test', subject: 'alice', principalType: 'user' } as const;
  const tenant = { id: 'a', name: 'A', status: 'active' as const, revision: 1, settings: {} };
  const store = new MemoryTenantRegistryStore([tenant]);
  const authorized = vi.fn();
  class AuthenticationGuard implements CanActivate {
    static readonly phase: GuardPhase = 'authenticate';
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
  Get('/:id')(Routes.prototype, 'read', Object.getOwnPropertyDescriptor(Routes.prototype, 'read')!);
  RequireResource({ action: 'read', resourceType: 'Doc', idParam: 'id' })(Routes);
  class App {}
  Module({
    controllers: [Routes],
    // Imported before authentication is registered; phases still order the guards.
    imports: [
      CedarModule.forRoot({
        authorize: async ({ context, identity }) => {
          const tenant = context
            .getContainer()!
            .resolve(TENANT_CONTEXT_READER, context.getModuleId())
            .requireTenant();
          expect(identity.tenantId).toBe(tenant.id);
          authorized();
          return tenant.id === 'a';
        },
      }),
      TenantModule.forRoot({
        lookup: store,
        authorize: ({ principal }) => principal.subject === 'alice',
      }),
    ],
    providers: [
      { provide: APP_GUARD, useExisting: CedarGuard },
      { provide: APP_GUARD, useExisting: TenantGuard },
      AuthenticationGuard,
      defineProvider(APP_GUARD, { useExisting: AuthenticationGuard }),
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
    expect(authorized).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

it('declares Cedar policy on headless CRUD resources under default deny', async () => {
  const principal = { issuer: 'test', subject: 'alice', principalType: 'user' } as const;
  const checked: string[] = [];
  class AuthenticationGuard implements CanActivate {
    static readonly phase: GuardPhase = 'authenticate';
    canActivate(context: ExecutionContext): boolean {
      if (context.getRequest().headers.get('x-auth') === 'verified')
        setTrustedRequestIdentity(context.getRequest(), { principal });
      return true;
    }
  }
  const schema = z.object({ id: z.string(), title: z.string() });
  const model = (name: string) =>
    defineModel({ name, tableName: `${name}s`, schema, id: 'client', timestamps: false });
  const store = new MemoryStore();
  store.table('notes').set('n1', { id: 'n1', title: 'First' });
  class App {}
  Module({
    imports: [
      // CedarModule's global guard denies routes without a declaration.
      CedarModule.forRoot({
        authorize: async ({ requirement }) => {
          checked.push(`${requirement.action} ${requirement.resourceType}`);
          return requirement.action === 'note:read';
        },
      }),
      CrudModule.forFeature([
        defineCrudFeature({
          path: '/notes',
          model: model('note'),
          adapter: memoryAdapter({ tableName: 'notes', store }),
          decorators: [RequireResource({ action: 'note:write', resourceType: 'Note' })],
          endpointDecorators: {
            list: [CedarPublic()],
            read: [RequireResource({ action: 'note:read', resourceType: 'Note', idParam: 'id' })],
          },
        }),
        defineCrudFeature({
          path: '/drafts',
          model: model('draft'),
          adapter: memoryAdapter({ tableName: 'drafts' }),
        }),
      ]),
    ],
    providers: [
      { provide: APP_GUARD, useExisting: CedarGuard },
      AuthenticationGuard,
      defineProvider(APP_GUARD, { useExisting: AuthenticationGuard }),
    ],
  })(App);
  const app = await VelaFactory.create(App);
  const hono = app.getHonoApp();
  const headers = { 'x-auth': 'verified', 'content-type': 'application/json' };
  try {
    // The list endpoint is public; reading authorizes against its own requirement.
    expect((await hono.request('/notes')).status).toBe(200);
    expect((await hono.request('/notes/n1', { headers })).status).toBe(200);
    expect((await hono.request('/notes/n1')).status).toBe(403);
    // Other endpoints use the resource's requirement, which the policy denies.
    const create = { method: 'POST', headers, body: JSON.stringify({ id: 'n2', title: 'x' }) };
    expect((await hono.request('/notes', create)).status).toBe(403);
    // A resource without declarations stays denied.
    expect((await hono.request('/drafts', { headers })).status).toBe(403);
    expect(checked).toEqual(['note:read Note', 'note:write Note']);
  } finally {
    await app.close();
  }
});
