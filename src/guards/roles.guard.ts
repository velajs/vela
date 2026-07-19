import {
  ForbiddenException,
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import { getAuthRequestState } from '../auth-request-state';
import { Roles } from '../decorators/roles.decorator';

const ACCESS_DENIED = 'Access denied';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(Roles, context);
    if (!required || required.length === 0) return true;

    const state = getAuthRequestState(context);
    if (!state.authenticated) {
      throw new ForbiddenException(ACCESS_DENIED);
    }

    const userRoles = normalizeRoles((state.user as { role?: string | string[] }).role);
    const ok = required.some((r) => userRoles.includes(r));
    if (!ok) {
      throw new ForbiddenException(ACCESS_DENIED);
    }
    return true;
  }
}

function normalizeRoles(role: string | string[] | undefined): string[] {
  if (!role) return [];
  if (Array.isArray(role)) return role;
  return role
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}
