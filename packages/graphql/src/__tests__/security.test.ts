import { describe, expect, it } from 'vitest';
import { AuthGuard, BetterAuthModule } from '@velajs/better-auth';
import { AuthzModule, PermissionGuard, RolesGuard, RequirePermission } from '@velajs/authz/vela';
import { MemoryTenantRegistryStore } from '@velajs/tenant';
import { TenantGuard, TenantModule } from '@velajs/tenant/vela';
import {
  APP_GUARD,
  Injectable,
  Module,
  REQUEST_CONTEXT,
  Scope,
  UseGuards,
  VelaFactory,
  type ExecutionContext,
} from '@velajs/vela';
import { getTrustedRequestIdentity } from '@velajs/vela/module-kit';
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
  it.each(['unlengthened', 'content-length', 'streaming'] as const)(
    'preserves concurrent HTTP authority and sibling permissions for %s bodies',
    async (bodyKind) => {
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
        expect(operation.container.resolve(REQUEST_CONTEXT).request).toBe(operation.request);
        expect(getTrustedRequestIdentity(operation.request)).toBe(operation.identity);
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
        providers: [
          Resolver,
          { provide: APP_GUARD, useExisting: AuthGuard },
          { provide: APP_GUARD, useExisting: TenantGuard },
          { provide: APP_GUARD, useExisting: PermissionGuard },
          { provide: APP_GUARD, useExisting: RolesGuard },
        ],
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
      const app = await VelaFactory.create(App, {
        diagnostics: 'silent',
        security: { body: { maxBytes: 512 } },
      });
      const observations: {
        sameRequest: boolean;
        sameIdentity: boolean;
        subject: string | undefined;
      }[] = [];
      // Runs in the authenticate phase, right after the global AuthGuard.
      const observer = {
        phase: 'authenticate',
        canActivate(context: ExecutionContext) {
          // Authentication must publish on the same normalized Request seen by injected providers.
          // Hono's body limiter rebuilds unlengthened bodies before this boundary.
          const scopedRequest = context.getContainer()!.resolve(REQUEST_CONTEXT).request;
          const identity = getTrustedRequestIdentity(context.getRequest());
          observations.push({
            sameRequest: scopedRequest === context.getRequest(),
            sameIdentity: getTrustedRequestIdentity(scopedRequest) === identity,
            subject: identity?.principal.subject,
          });
          return true;
        },
      };
      app.useGlobalGuards(observer);
      const call = (user: string | undefined, selectedTenant: string, query: string) => {
        const body = JSON.stringify({ query });
        const encoded = new TextEncoder().encode(body);
        const init = {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(user ? { 'x-fixture-user': user } : {}),
            'x-tenant-id': selectedTenant,
            ...(bodyKind === 'content-length'
              ? { 'content-length': String(encoded.byteLength) }
              : {}),
          },
          body:
            bodyKind === 'streaming'
              ? new ReadableStream<Uint8Array>({
                  start(controller) {
                    const middle = Math.ceil(encoded.byteLength / 2);
                    controller.enqueue(encoded.slice(0, middle));
                    controller.enqueue(encoded.slice(middle));
                    controller.close();
                  },
                })
              : body,
          duplex: 'half',
        };
        return app.getHonoApp().request(new Request('https://example.test/graphql', init));
      };
      try {
        const responses = await Promise.all(
          ['a', 'b'].map((id) => call(id, id, '{ x:allowed y:allowed denied }')),
        );
        expect(observations).toHaveLength(2);
        expect(observations).toEqual(
          expect.arrayContaining(
            ['a', 'b'].map((subject) => ({
              sameRequest: true,
              sameIdentity: true,
              subject,
            })),
          ),
        );
        for (const [index, response] of responses.entries()) {
          expect(response.status).toBe(200);
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
        const foreignTenant = await call('a', 'b', '{ allowed }');
        expect(foreignTenant.status).toBe(403);
        await foreignTenant.text();
        expect(constructions).toBe(2);
        expect(await (await call('a', 'a', '{ denied }')).json()).toMatchObject({
          data: { denied: null },
        });
        expect(constructions).toBe(2);
        const unknownTenant = await call('a', 'missing', '{ allowed }');
        expect(unknownTenant.status).toBe(403);
        await unknownTenant.text();
        const anonymous = await call(undefined, 'a', '{ allowed }');
        expect(anonymous.status).toBe(401);
        await anonymous.text();
        const oversized = await call('a', 'a', `{ ${'allowed '.repeat(100)} }`);
        expect(oversized.status).toBe(413);
        await oversized.text();
        expect({ authentications, admissions, constructions, loads }).toEqual({
          authentications: 6,
          admissions: 4,
          constructions: 2,
          loads: 2,
        });
        expect(observations).toHaveLength(5); // Anonymous and oversized requests never reach tenant admission.
      } finally {
        await app.dispose();
      }
    },
  );
});
