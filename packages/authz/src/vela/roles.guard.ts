import {
  ForbiddenException,
  Inject,
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type GuardPhase,
} from '@velajs/vela';
import { Roles } from './roles.decorator';
import { getContextIdentity } from './context-identity';

/** Role requirements are OR: at least one explicitly granted local role. */
export class RolesGuard implements CanActivate {
  /** Global guards authorize after authentication and tenant admission. */
  static readonly phase: GuardPhase = 'authorize';
  /** Integration routes marked `SkipGuardPhases(['authorize'])` authorize themselves. */
  static readonly skippable = true;

  constructor(private readonly reflector: Reflector) {}

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
// This package is authored without decorator syntax.
Injectable()(RolesGuard);
Inject(Reflector)(RolesGuard, undefined, 0);
