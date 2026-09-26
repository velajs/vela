import {
  APP_GUARD,
  ENV,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  Scope,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import {
  clearTrustedContextIdentity,
  getTrustedContextIdentity,
  setTrustedContextIdentity,
} from '@velajs/vela/module-kit';
import { VelaEntrypoint, ENTRYPOINT_PROPS } from '@velajs/cloudflare/entrypoints';
import { TenantModule, TenantGuard, TENANT_CONTEXT_READER } from '@velajs/tenant/vela';
import { MemoryTenantRegistryStore, type TenantContextReader } from '@velajs/tenant';
import { AuthzModule, PermissionGuard, RequirePermission } from '@velajs/authz/vela';
import { defineRole } from '@velajs/authz';
import { CedarModule, CedarGuard, RequireResource } from '@velajs/authz-cedar/vela';
import {
  catalogInput,
  verifiedIdentity,
  type CatalogInput,
  type CatalogResult,
  type IdentityBinding,
  type MembershipBinding,
} from './native-contracts';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { Rpc, RpcModule } from '@velajs/rpc/server';
import { catalog } from './contracts';
@Injectable()
class CatalogService {
  @Rpc(catalog) read(id: string) {
    return { id, label: 'Example document' };
  }
}
@Module({ providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
function invocationPayload(context: ExecutionContext): unknown {
  if (
    context.getType() !== 'rpc' ||
    !('getPayload' in context) ||
    typeof context.getPayload !== 'function'
  )
    throw new ForbiddenException();
  return context.getPayload();
}
interface CatalogEnv {
  IDENTITY: IdentityBinding;
  MEMBERSHIP: MembershipBinding;
}
@Injectable()
class CatalogBindings {
  constructor(@Inject(ENV) readonly env: CatalogEnv) {}
}
@Module({ providers: [CatalogBindings], exports: [CatalogBindings] })
class CatalogBindingsModule {}
@Injectable({ scope: Scope.REQUEST })
class CallState {
  context?: ExecutionContext;
}
@Injectable()
class Authenticate implements CanActivate {
  constructor(
    @Inject(ENTRYPOINT_PROPS) private readonly props: unknown,
    @Inject(ENV) private readonly env: CatalogEnv,
    private readonly state: CallState,
  ) {}
  async canActivate(context: ExecutionContext) {
    clearTrustedContextIdentity(context);
    // Props identify the calling application only. They cannot identify an end user.
    const caller =
      typeof this.props === 'object' && this.props !== null
        ? Object.getOwnPropertyDescriptor(this.props, 'caller')
        : undefined;
    if (!caller || !('value' in caller) || caller.value !== 'example-api')
      throw new ForbiddenException();
    const args = invocationPayload(context);
    const input = catalogInput.safeParse(Array.isArray(args) ? args[0] : undefined);
    if (!input.success) throw new ForbiddenException();
    const result = verifiedIdentity.safeParse(
      await this.env.IDENTITY.verify(input.data.credential),
    );
    if (!result.success) throw new ForbiddenException();
    setTrustedContextIdentity(context, result.data);
    this.state.context = context;
    return true;
  }
}
// APP_* are HTTP policy. Native calls run only their explicitly ordered guards.
@Injectable()
class HttpOnly implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') throw new ForbiddenException('HTTP only');
    return true;
  }
}
@Injectable()
@UseGuards(Authenticate, TenantGuard, PermissionGuard, CedarGuard)
@RequirePermission(['catalog:read'])
@RequireResource({ action: 'read', resourceType: 'Document' })
class NativeCatalogHost {
  constructor(
    private readonly state: CallState,
    @Inject(TENANT_CONTEXT_READER) private readonly tenant: TenantContextReader,
  ) {}
  read(input: CatalogInput): CatalogResult {
    const context = this.state.context;
    const identity = context && getTrustedContextIdentity(context);
    if (!identity || !context) throw new ForbiddenException();
    // Native contexts keep their real transport; an HTTP accessor must throw.
    let noHttp = false;
    try {
      context.getRequest();
    } catch {
      noHttp = true;
    }
    if (!noHttp || context.getType() !== 'rpc') throw new Error('Unexpected transport');
    return {
      subject: identity.principal.subject,
      tenantId: this.tenant.requireTenantId(),
      documentId: input.documentId,
      frozen: Object.isFrozen(identity) && Object.isFrozen(identity.claims),
    };
  }
}
@Module({
  imports: [
    CatalogModule,
    CatalogBindingsModule,
    RpcModule.forRoot({ authorize: 'public' }),
    TenantModule.forRootAsync({
      imports: [CatalogBindingsModule],
      inject: [CatalogBindings],
      useFactory: ({ env }) => ({
        lookup: new MemoryTenantRegistryStore(
          ['team-a', 'team-b'].map((id) => ({
            id,
            name: id,
            status: 'active',
            revision: 1,
            settings: {},
          })),
        ),
        authorize: ({ principal, tenant }) => env.MEMBERSHIP.admits(principal.subject, tenant.id),
        resolve: (context) => {
          const identity = getTrustedContextIdentity(context);
          const args = invocationPayload(context);
          const input = catalogInput.parse(Array.isArray(args) ? args[0] : undefined);
          return identity
            ? {
                tenantId: input.tenantId,
                principal: { ...identity.principal, expiresAtMs: identity.expiresAtMs },
                source: 'rpc',
              }
            : undefined;
        },
      }),
    }),
    AuthzModule.forRoot({ roles: [defineRole('reader', ['catalog:read'])] }),
    CedarModule.forRoot({
      authorize: async ({ identity, context }) => {
        await Promise.resolve();
        const documents = new Map([
          ['document-a', 'team-a'],
          ['document-b', 'team-b'],
        ]);
        const args = invocationPayload(context);
        const input = catalogInput.parse(Array.isArray(args) ? args[0] : undefined);
        return (
          identity.claims?.catalog === true &&
          documents.has(input.documentId) &&
          documents.get(input.documentId) === identity.tenantId
        );
      },
    }),
  ],
  providers: [CallState, Authenticate, { provide: APP_GUARD, useClass: HttpOnly }],
})
class CatalogWorkerModule {}
const app = defineCloudflareApp(CatalogWorkerModule);
export class Catalog extends VelaEntrypoint(app, NativeCatalogHost, { rpc: ['read'] }) {}
export default app.worker;
