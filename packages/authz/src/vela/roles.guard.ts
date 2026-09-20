import {
  ForbiddenException,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import { Roles } from './roles.decorator';
import { getContextIdentity } from './context-identity';

/** Role requirements are OR: at least one explicitly granted local role. */
export class RolesGuard implements CanActivate {
  private readonly reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(Roles, context);
    if (!required?.length) return true;
    const identity = getContextIdentity(context);
    if (!identity || !required.some((role) => identity.roles?.includes(role))) {
      throw new ForbiddenException('Access denied');
    }
    return true;
  }
}
