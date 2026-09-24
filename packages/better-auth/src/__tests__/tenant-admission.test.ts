import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Module,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import {
  clearTrustedRequestIdentity,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
} from '@velajs/vela/module-kit';
import { AuthzModule, PermissionGuard, RequirePermission } from '@velajs/authz/vela';
import { TenantModule, TenantGuard, CurrentTenant } from '@velajs/tenant/vela';
import { MemoryTenantRegistryStore, type TenantSnapshot } from '@velajs/tenant';
import { AuthGuard, BetterAuthModule, CurrentUser, CurrentSession } from '../index';
import type { User, Session } from '../better-auth.types';
import { sessionFixture } from './fixtures';

async function application(issuer: string) {
  class Revoke implements CanActivate {
    canActivate(context: ExecutionContext) {
      const request = context.getRequest();
      const identity = getTrustedRequestIdentity(request);
      if (request.headers.has('x-replace') && identity) {
        // Even an equal-principal replacement is a new authentication.
        setTrustedRequestIdentity(request, identity);
      } else clearTrustedRequestIdentity(request);
      return true;
    }
  }
  @Controller('/tenant')
  @UseGuards(AuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission(['data:read'])
  class Routes {
    @Get()
    read(
      @CurrentUser() user: User | undefined,
      @CurrentSession() session: Session | undefined,
      @CurrentTenant() tenant: TenantSnapshot,
    ) {
      return {
        user: user?.id,
        session: session?.id,
        tenant: tenant.id,
        issuer: tenant.principal.issuer,
      };
    }
    @Get('/revoke')
    @UseGuards(Revoke)
    revoked(@CurrentUser() user: User | undefined, @CurrentSession() session: Session | undefined) {
      return { user: user?.id ?? null, session: session?.id ?? null };
    }
  }
  @Module({
    imports: [
      BetterAuthModule.forRoot({
        issuer,
        globalGuard: false,
        mountHandler: false,
        auth: {
          api: {
            getSession: async ({ headers }: { headers: Headers }) => {
              const fixture = sessionFixture(headers.get('x-user') ?? 'a');
              const { activeOrganizationId: _, ...session } = fixture.session;
              return {
                user: fixture.user,
                session: headers.has('x-bound')
                  ? { ...session, activeOrganizationId: headers.get('x-bound') }
                  : session,
              };
            },
          },
          handler: async () => new Response(),
        },
      }),
      TenantModule.forRoot({
        lookup: new MemoryTenantRegistryStore(
          ['a', 'b'].map((id) => ({
            id,
            name: id,
            status: 'active',
            revision: 1,
            settings: {},
          })),
        ),
        authorize: async ({ tenant, principal }) => {
          await Promise.resolve();
          return principal.subject === tenant.id && principal.issuer === issuer;
        },
      }),
      AuthzModule.forRoot({
        resolver: {
          grants: async (identity) =>
            new Set(identity.tenantId === identity.subject ? ['data:read'] : []),
        },
      }),
    ],
    controllers: [Routes],
  })
  class App {}
  return VelaFactory.create(App);
}

describe('authentication and tenant admission pipeline', () => {
  it('preserves user/session through admission and authorization across concurrent tenants and apps', async () => {
    const apps = await Promise.all(['one', 'two'].map(application));
    try {
      for (const [index, app] of apps.entries()) {
        const responses = await Promise.all(
          ['a', 'b'].map((id) =>
            app.getHonoApp().request('/tenant', {
              headers: { 'x-user': id, 'x-tenant-id': id },
            }),
          ),
        );
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
          ['a', 'b'].map((id) => ({
            user: id,
            session: `session-${id}`,
            tenant: id,
            issuer: index === 0 ? 'one' : 'two',
          })),
        );
      }
      const app = apps[0]!;
      expect(
        (
          await app.getHonoApp().request('/tenant', {
            headers: { 'x-user': 'a', 'x-bound': 'a', 'x-tenant-id': 'a' },
          })
        ).status,
      ).toBe(200);
      for (const headers of [
        new Headers({ 'x-user': 'a', 'x-tenant-id': 'b' }),
        new Headers({ 'x-user': 'a', 'x-bound': 'a', 'x-tenant-id': 'b' }),
      ])
        expect((await app.getHonoApp().request('/tenant', { headers })).status).toBe(403);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  });

  it('still invalidates provider payload after clear or equal-principal replacement following admission', async () => {
    const app = await application('one');
    try {
      for (const replace of [false, true]) {
        const headers = new Headers({ 'x-user': 'a', 'x-tenant-id': 'a' });
        if (replace) headers.set('x-replace', 'yes');
        const response = await app.getHonoApp().request('/tenant/revoke', { headers });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ user: null, session: null });
      }
    } finally {
      await app.close();
    }
  });
});
