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
  resolve<T>(token: unknown, requestingModuleId?: string): T;
  resolveAll?<T>(token: unknown, requestingModuleId?: string): T[];
}

const ACCESS_DENIED = 'Access denied';

function resolveSingleAuthz(container: ContainerLike, moduleId: string): Authz | undefined {
  try {
    if (typeof container.resolveAll === 'function') {
      const candidates = container.resolveAll<Authz>(AUTHZ, moduleId);
      return candidates.length === 1 ? candidates[0] : undefined;
    }
    return container.resolve<Authz>(AUTHZ, moduleId);
  } catch {
    return undefined;
  }
}

/**
 * Enforces `@RequireAccessPermission(...)` against the `@velajs/authz` engine,
 * mapping the Access identity {@link CloudflareAccessGuard} stashed
 * ({@link ACCESS_IDENTITY_KEY}) through {@link identityFromAccess}. Requires
 * **all** listed permissions (AND). Runs after `CloudflareAccessGuard`
 * (e.g. `@UseGuards(CloudflareAccessGuard, AccessPermissionGuard)`).
 *
 * `AUTHZ` is resolved at request time and exactly one registration must be
 * visible. Fail-closed on every abnormal path:
 * - no required permissions → allow (nothing to enforce);
 * - zero or multiple `AUTHZ` registrations → deny;
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

    const moduleId = context.getModuleId();
    const authz = moduleId === undefined ? undefined : resolveSingleAuthz(container, moduleId);
    if (!authz) throw new ForbiddenException(ACCESS_DENIED);

    const reqCtx = container.resolve<RequestContext>(REQUEST_CONTEXT);
    const identity = reqCtx.get<ResolvedIdentity>(ACCESS_IDENTITY_KEY);
    if (!identity) {
      throw new ForbiddenException(ACCESS_DENIED);
    }

    const mapped = identityFromAccess(identity);
    for (const permission of required) {
      if (!(await authz.can(mapped, permission))) {
        throw new ForbiddenException(ACCESS_DENIED);
      }
    }
    return true;
  }
}
