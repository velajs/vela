import { attachAccessPayload, getAccessRequestIdentity } from './access-request-state';
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import {
  clearTrustedRequestIdentity,
  setTrustedRequestIdentity,
  getTrustedContextRequest,
} from '@velajs/vela/module-kit';
import type { ResolveIdentity } from '../types';
import {
  ACCESS_MODULE_OPTIONS,
  ACCESS_RESOLVER,
  type CloudflareAccessModuleOptions,
} from './tokens';

/** Verify and publish to core's single trusted request identity contract. */
@Injectable()
export class CloudflareAccessGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_RESOLVER) private readonly resolve: ResolveIdentity,
    @Inject(ACCESS_MODULE_OPTIONS) private readonly options: CloudflareAccessModuleOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Access is an HTTP verifier; established frames must use the authenticated
    // socket attachment through authz, never re-run token extraction.
    if (context.getType() !== 'http') {
      if (
        getTrustedContextRequest(context) &&
        (getAccessRequestIdentity(context) || this.options.mode === 'optional')
      )
        return true;
      throw new UnauthorizedException('Access requires HTTP authentication');
    }
    const request = context.getRequest();
    clearTrustedRequestIdentity(request);
    try {
      const identity = await this.resolve(request);
      if (identity) {
        setTrustedRequestIdentity(request, {
          principal: {
            issuer: identity.issuer,
            subject: identity.subject,
            principalType: identity.principalType,
          },
          expiresAtMs: identity.expiresAtMs,
          roles: identity.roles ?? [],
          claims: identity.claims,
          ...(identity.tenantId === undefined ? {} : { tenantId: identity.tenantId }),
        });
        attachAccessPayload(request, identity);
        return true;
      }
    } catch {
      clearTrustedRequestIdentity(request);
      throw new UnauthorizedException('Access authentication failed');
    }
    if ((this.options.mode ?? 'required') === 'optional') return true;
    throw new UnauthorizedException('Access authentication required');
  }
}
