import {
  ForbiddenException,
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type InjectionToken,
} from '@velajs/vela';
import { AUTHZ } from '@velajs/authz/vela';
import type { Authz, Identity } from '@velajs/authz';
import { getAuthRequestState } from '../auth-request-state';
import { identityFromUser } from '../authz-bridge';
import { RequirePermission } from '../decorators/require-permission.decorator';

// The linked `@velajs/authz` is built against its own (newer) `@velajs/vela`
// copy, so the `AUTHZ` token's `InjectionToken` type is nominally distinct from
// this package's `InjectionToken` — even though it is the very same runtime
// token object (the DI container matches tokens by object identity). Re-type it
// to the local `InjectionToken` so the request-time `container.resolve(...)`
// accepts it without a structural clash. This is purely a compile-time alias;
// it changes nothing at runtime. (Version-skew workaround until both publish.)
const AUTHZ_TOKEN = AUTHZ as unknown as InjectionToken<Authz>;
const ACCESS_DENIED = 'Access denied';

interface ContainerLike {
  resolve<T>(token: unknown, requestingModuleId?: string): T;
  resolveAll?<T>(token: unknown, requestingModuleId?: string): T[];
}

function resolveSingleAuthz(container: ContainerLike, moduleId: string): Authz | undefined {
  try {
    if (typeof container.resolveAll === 'function') {
      const candidates = container.resolveAll<Authz>(AUTHZ_TOKEN, moduleId);
      return candidates.length === 1 ? candidates[0] : undefined;
    }
    return container.resolve<Authz>(AUTHZ_TOKEN, moduleId);
  } catch {
    return undefined;
  }
}

/**
 * Enforces the `@RequirePermission(...)` metadata against the `@velajs/authz`
 * engine. For each required permission it calls `authz.can(identity, perm)`,
 * requiring **all** of them (AND semantics — contrast {@link RolesGuard}, which
 * is OR over roles). The caller's `Identity` is derived from the better-auth
 * user that {@link AuthGuard} placed in canonical request-local auth state, so this guard must
 * run *after* `AuthGuard` (e.g. `@UseGuards(AuthGuard, PermissionGuard)`).
 *
 * `AUTHZ` is resolved at request time from the per-request container. Exactly
 * one reachable engine is required; zero or multiple registrations deny rather
 * than selecting one by import order.
 *
 * Fail-closed on every abnormal path — no branch grants access on missing
 * wiring or a missing caller:
 * - no required permissions → allow (nothing to enforce);
 * - `AUTHZ` unresolvable (`AuthzModule` not registered) → deny (`ForbiddenException`);
 * - no authenticated user in request-local auth state → deny;
 * - any single required permission not granted → deny.
 *
 * The guard is stateless (no injected dependencies), so it is safe to register
 * as a plain provided guard.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly reflector = new Reflector();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride(RequirePermission, context);
    if (!required || required.length === 0) return true;

    const container = resolveContextContainer(context);
    const moduleId = context.getModuleId();

    // Resolve all visible AUTHZ registrations and accept only an unambiguous
    // single engine. This prevents import order from selecting another tenant's
    // or feature module's authorization policy.
    const authz =
      container === undefined || moduleId === undefined
        ? undefined
        : resolveSingleAuthz(container, moduleId);
    if (!authz) {
      throw new ForbiddenException(ACCESS_DENIED);
    }

    const identity = resolveContextIdentity(context);
    if (identity === undefined) throw new ForbiddenException(ACCESS_DENIED);
    for (const permission of required) {
      if (!(await authz.can(identity, permission))) {
        throw new ForbiddenException(ACCESS_DENIED);
      }
    }
    return true;
  }
}

function resolveContextContainer(context: ExecutionContext): ContainerLike | undefined {
  const direct = context.getContainer?.<ContainerLike>();
  if (direct !== undefined) return direct;
  if (context.getType() !== 'http') return undefined;
  try {
    const honoCtx = context.getContext() as { get: (key: string) => ContainerLike | undefined };
    return honoCtx.get('container');
  } catch {
    return undefined;
  }
}

function resolveContextIdentity(context: ExecutionContext): Identity | undefined {
  if (context.getType() === 'ws') {
    try {
      const data = context.switchToWs().getClient<{ data?: unknown }>()?.data;
      if (!data || typeof data !== 'object') return undefined;
      const record = data as Record<string, unknown>;
      const principal = record.principal;
      if (!principal || typeof principal !== 'object') return undefined;
      const fields = principal as Record<string, unknown>;
      if (
        typeof fields.issuer !== 'string' ||
        fields.issuer.length === 0 ||
        typeof fields.subject !== 'string' ||
        fields.subject.length === 0 ||
        (fields.principalType !== 'user' && fields.principalType !== 'service') ||
        typeof record.tenantId !== 'string' ||
        record.tenantId.length === 0 ||
        typeof record.expiresAtMs !== 'number' ||
        !Number.isSafeInteger(record.expiresAtMs) ||
        record.expiresAtMs <= Date.now()
      ) {
        return undefined;
      }
      return {
        issuer: fields.issuer,
        subject: fields.subject,
        principalType: fields.principalType,
        userId: fields.subject,
        roles: [],
      };
    } catch {
      return undefined;
    }
  }

  const state = getAuthRequestState(context);
  return state.authenticated
    ? identityFromUser(state.user, state.issuer, state.principalType)
    : undefined;
}
