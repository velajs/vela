import {
  ForbiddenException,
  Injectable,
  InjectionToken,
  REQUEST_CONTEXT,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import { AUTHZ } from '@velajs/authz/vela';
import type { Authz } from '@velajs/authz';
import { AUTH_USER_KEY } from '../better-auth.tokens';
import type { User } from '../better-auth.types';
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

/**
 * Enforces the `@RequirePermission(...)` metadata against the `@velajs/authz`
 * engine. For each required permission it calls `authz.can(identity, perm)`,
 * requiring **all** of them (AND semantics — contrast {@link RolesGuard}, which
 * is OR over roles). The caller's `Identity` is derived from the better-auth
 * user that {@link AuthGuard} placed in the request context, so this guard must
 * run *after* `AuthGuard` (e.g. `@UseGuards(AuthGuard, PermissionGuard)`).
 *
 * `AUTHZ` is resolved at **request time** from the per-request container (the
 * same container `REQUEST_CONTEXT` is resolved from), not constructor-injected.
 * This deliberately avoids DI visibility coupling: the guard works whether or
 * not `AuthzModule` is registered as global — a present-but-non-global
 * `AuthzModule` resolves fine and, crucially, never crashes bootstrap. If
 * `AuthzModule` is not registered at all the resolve fails and the guard fails
 * closed (403) rather than granting access.
 *
 * Fail-closed on every abnormal path — no branch grants access on missing
 * wiring or a missing caller:
 * - no required permissions → allow (nothing to enforce);
 * - `AUTHZ` unresolvable (`AuthzModule` not registered) → deny (`ForbiddenException`);
 * - no authenticated user in the request context → deny;
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

    const honoCtx = context.getContext() as {
      get: (k: string) => { resolve<T>(t: unknown): T };
    };
    const container = honoCtx.get('container');

    // Resolve AUTHZ at request time from the per-request container — the SAME
    // container REQUEST_CONTEXT resolves from. Because this lookup carries no
    // requesting module, it matches AUTHZ by its exporter, so a non-global
    // `AuthzModule` is reachable without forcing the app to declare it global.
    // `resolve` throws (or, defensively, could yield undefined) for an
    // unregistered token, so wrap it and fail closed on any failure.
    let authz: Authz | undefined;
    try {
      authz = container.resolve<Authz>(AUTHZ_TOKEN);
    } catch {
      authz = undefined;
    }
    if (!authz) {
      throw new ForbiddenException('Authorization is not configured');
    }

    const reqCtx = container.resolve<RequestContext>(REQUEST_CONTEXT);
    const user = reqCtx.get<User & { id?: string; role?: string | string[] }>(AUTH_USER_KEY);
    if (!user) {
      throw new ForbiddenException('Permission check requires authentication');
    }

    const identity = identityFromUser(user);
    for (const permission of required) {
      if (!(await authz.can(identity, permission))) {
        throw new ForbiddenException(`Missing permission: ${permission}`);
      }
    }
    return true;
  }
}
