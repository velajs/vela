import {
  ForbiddenException,
  Injectable,
  REQUEST_CONTEXT,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import { AUTHZ } from '@velajs/authz/vela';
import type { Authz } from '@velajs/authz';
import type { ResolvedIdentity } from '../types';
import { identityFromAccess } from './authz-bridge';
import { ACCESS_IDENTITY_KEY } from './tokens';
import { RequireAccessPermission } from './require-permission.decorator';

/** The per-request DI container, reached via the Hono context. */
interface ContainerLike {
  resolve<T>(token: unknown): T;
}

/**
 * Enforces `@RequireAccessPermission(...)` against the `@velajs/authz` engine,
 * mapping the Access identity {@link CloudflareAccessGuard} stashed
 * ({@link ACCESS_IDENTITY_KEY}) through {@link identityFromAccess}. Requires
 * **all** listed permissions (AND). Runs after `CloudflareAccessGuard`
 * (e.g. `@UseGuards(CloudflareAccessGuard, AccessPermissionGuard)`).
 *
 * `AUTHZ` is resolved at **request time** from the per-request container (not
 * constructor-injected), so the guard works whether or not `AuthzModule` is
 * global and never crashes bootstrap. Fail-closed on every abnormal path:
 * - no required permissions → allow (nothing to enforce);
 * - `AUTHZ` unresolvable (`AuthzModule` not registered) → deny;
 * - no Access identity in the request context → deny;
 * - any single required permission not granted → deny.
 */
@Injectable()
export class AccessPermissionGuard implements CanActivate {
  private readonly reflector = new Reflector();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride(RequireAccessPermission, context);
    if (!required || required.length === 0) return true;

    const container = context
      .getContext<{ get(key: 'container'): ContainerLike }>()
      .get('container');

    let authz: Authz | undefined;
    try {
      authz = container.resolve<Authz>(AUTHZ);
    } catch {
      authz = undefined;
    }
    if (!authz) throw new ForbiddenException('Authorization is not configured');

    const reqCtx = container.resolve<RequestContext>(REQUEST_CONTEXT);
    const identity = reqCtx.get<ResolvedIdentity>(ACCESS_IDENTITY_KEY);
    if (!identity) {
      throw new ForbiddenException('Permission check requires an authenticated Access identity');
    }

    const mapped = identityFromAccess(identity);
    for (const permission of required) {
      if (!(await authz.can(mapped, permission))) {
        throw new ForbiddenException(`Missing permission: ${permission}`);
      }
    }
    return true;
  }
}
