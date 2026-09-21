import { describe, expect, it } from 'vitest';
import { AuthGuard, BetterAuthModule } from '@velajs/better-auth';
import { AuthzModule, PermissionGuard, RequirePermission } from '@velajs/authz/vela';
import { MemoryTenantRegistryStore } from '@velajs/tenant';
import { TenantGuard, TenantModule } from '@velajs/tenant/vela';
import { Injectable, Module, Scope, UseGuards, VelaFactory } from '@velajs/vela';
import { createSchema } from 'graphql-yoga';
import { z } from 'zod';
import {
  bindResolver,
  GraphqlLoader,
  GraphqlModule,
  type GraphqlContext,
  type GraphqlResolverContext,
} from '../index';
import { yogaDriver } from '../yoga';

describe('GraphQL trusted HTTP authority', () => {
  it('authenticates and admits once, authorizes each sibling and isolates tenants/loaders', async () => {
    let authentications = 0,
      admissions = 0,
      constructions = 0,
      loads = 0;
    const auth = BetterAuthModule.forRoot({
      issuer: 'test',
      mountHandler: false,
      auth: {
        api: {
          getSession: async ({ headers }: { headers: Headers }) => {
            authentications++;
            const id = headers.get('x-fixture-user');
            if (!id) return null;
            return {
              user: {
                id,
                name: id,
                email: `${id}@example.test`,
                emailVerified: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              session: {
                id: `session-${id}`,
                userId: id,
                token: 'fixture',
                createdAt: new Date(),
                updatedAt: new Date(),
                expiresAt: new Date('2099-01-01'),
              },
            };
          },
        },
        handler: async () => new Response(),
      },
    });
    const tenant = TenantModule.forRoot({
      lookup: new MemoryTenantRegistryStore(
        ['a', 'b'].map((id) => ({ id, name: id, status: 'active', revision: 1, settings: {} })),
      ),
      authorize: ({ principal, tenant }) => {
        admissions++;
        return principal.subject === tenant.id;
      },
    });
    const authz = AuthzModule.forRoot({
      resolver: {
        grants: async (identity) =>
          new Set(identity.subject === identity.tenantId ? ['data:read'] : []),
      },
    });
    const loader = new GraphqlLoader((operation) => {
      loads++;
      return operation.identity?.tenantId;
    });
    class Resolver {
      constructor() {
        constructions++;
      }
      async allowed(_args: object, context: GraphqlResolverContext) {
        return context.operation.loader(loader);
      }
      denied() {
        return 'secret';
      }
    }
    Injectable({ scope: Scope.REQUEST })(Resolver);
    UseGuards(AuthGuard, PermissionGuard)(Resolver);
    RequirePermission(['data:read'])(
      Resolver.prototype,
      'allowed',
      Object.getOwnPropertyDescriptor(Resolver.prototype, 'allowed')!,
    );
    RequirePermission(['data:write'])(
      Resolver.prototype,
      'denied',
      Object.getOwnPropertyDescriptor(Resolver.prototype, 'denied')!,
    );
    class App {}
    Module({
      providers: [Resolver],
      imports: [
        auth,
        tenant,
        authz,
        GraphqlModule.forRoot({
          imports: [auth, tenant, authz],
          driver: yogaDriver(),
          schema: createSchema<GraphqlContext>({
            typeDefs: 'type Query { allowed:String denied:String }',
            resolvers: {
              Query: {
                allowed: bindResolver(Resolver, 'allowed', { args: z.object({}) }),
                denied: bindResolver(Resolver, 'denied', { args: z.object({}) }),
              },
            },
          }),
        }),
      ],
    })(App);
    const app = await VelaFactory.create(App, { diagnostics: 'silent' });
    app.useGlobalGuards(new TenantGuard());
    const call = (user: string, selectedTenant: string, query: string) =>
      app.getHonoApp().request('/graphql', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fixture-user': user,
          'x-tenant-id': selectedTenant,
        },
        body: JSON.stringify({ query }),
      });
    try {
      const responses = await Promise.all(
        ['a', 'b'].map((id) => call(id, id, '{ x:allowed y:allowed denied }')),
      );
      for (const [index, response] of responses.entries()) {
        expect(await response.json()).toMatchObject({
          data: { x: index === 0 ? 'a' : 'b', y: index === 0 ? 'a' : 'b', denied: null },
          errors: [{ extensions: { code: 'FORBIDDEN' } }],
        });
      }
      expect({ authentications, admissions, constructions, loads }).toEqual({
        authentications: 2,
        admissions: 2,
        constructions: 2,
        loads: 2,
      });
      expect((await call('a', 'b', '{ allowed }')).status).toBe(403);
      expect(constructions).toBe(2);
      expect(await (await call('a', 'a', '{ denied }')).json()).toMatchObject({
        data: { denied: null },
      });
      expect(constructions).toBe(2);
    } finally {
      await app.dispose();
    }
  });
});
