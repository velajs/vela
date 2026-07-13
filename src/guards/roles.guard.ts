import {
  ForbiddenException,
  Injectable,
  REQUEST_CONTEXT,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import { AUTH_USER_KEY } from '../better-auth.tokens';
import type { User } from '../better-auth.types';
import { Roles } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(Roles, context);
    if (!required || required.length === 0) return true;

    const honoCtx = context.getContext() as {
      get: (k: string) => { resolve<T>(t: unknown): T };
    };
    const reqCtx = honoCtx.get('container').resolve<RequestContext>(REQUEST_CONTEXT);
    const user = reqCtx.get<User & { role?: string | string[] }>(AUTH_USER_KEY);
    if (!user) {
      throw new ForbiddenException('Role check requires authentication');
    }

    const userRoles = normalizeRoles(user.role);
    const ok = required.some((r) => userRoles.includes(r));
    if (!ok) {
      throw new ForbiddenException(`Insufficient role; one of [${required.join(', ')}] required`);
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
