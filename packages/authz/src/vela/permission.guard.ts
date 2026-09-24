import {
  ForbiddenException,
  Inject,
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type GuardPhase,
} from '@velajs/vela';
import { getTrustedContextRequest } from '@velajs/vela/module-kit';
import type { Authz } from '../authz';
import { AUTHZ } from './tokens';
import { RequirePermission } from './require-permission.decorator';
import { getContextIdentity, identityFromTrusted } from './context-identity';

/** Enforce every permission using exactly one engine visible to the route module. */
export class PermissionGuard implements CanActivate {
  /** Global guards authorize after authentication and tenant admission. */
  static readonly phase: GuardPhase = 'authorize';
  /** Integration routes marked `SkipGuardPhases(['authorize'])` authorize themselves. */
  static readonly skippable = true;

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride(RequirePermission, context);
    if (!required?.length) return true;
    const trusted = getContextIdentity(context);
    const moduleId = context.getModuleId();
    if (!trusted || !moduleId) throw new ForbiddenException('Access denied');

    let authz: Authz | undefined;
    try {
      const container = context.getContainer();
      const candidates = container?.resolveAll(AUTHZ, moduleId);
      authz = candidates?.length === 1 ? candidates[0] : undefined;
    } catch {
      throw new ForbiddenException('Access denied');
    }
    if (!authz) throw new ForbiddenException('Access denied');
    const identity = identityFromTrusted(trusted);
    for (const permission of required) {
      if (!(await authz.can(identity, permission))) throw new ForbiddenException('Access denied');
    }
    // A slow resolver may cross expiry, or clear/replace the request's identity.
    const current = getContextIdentity(context);
    if (
      !current ||
      (getTrustedContextRequest(context) !== undefined && current !== trusted) ||
      current.principal.issuer !== trusted.principal.issuer ||
      current.principal.subject !== trusted.principal.subject ||
      current.principal.principalType !== trusted.principal.principalType ||
      current.tenantId !== trusted.tenantId ||
      current.expiresAtMs !== trusted.expiresAtMs
    ) {
      throw new ForbiddenException('Access denied');
    }
    return true;
  }
}
// This package is authored without decorator syntax.
Injectable()(PermissionGuard);
Inject(Reflector)(PermissionGuard, undefined, 0);
