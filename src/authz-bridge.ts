import type { Identity, PermissionResolver } from '@velajs/authz';
import type { User } from './better-auth.types';

/**
 * A better-auth user carrying the optional `role` field contributed by the
 * admin plugin. `role` may be a single role, a comma-separated list, or an
 * array — {@link identityFromUser} normalizes all three.
 */
export type AuthUser = User & { role?: string | string[] | null };

/** Stable issuer namespace used for better-auth session principals. */
export const BETTER_AUTH_ISSUER = 'better-auth';

const normalizeRoles = (role: string | string[] | null | undefined): string[] => {
  if (!role) return [];
  // Strip empty entries and return a fresh array (never alias the caller's
  // input), matching the comma-string path below.
  if (Array.isArray(role)) return role.filter(Boolean);
  return role
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
};

/**
 * Adapts a better-auth user into a stable `@velajs/authz` {@link Identity}.
 * The issuer scopes `user.id` as both `subject` and the compatibility `userId`;
 * the admin-plugin `role` field supplies local roles.
 *
 * Fail-closed: a missing user (`null`/`undefined`, i.e. an unauthenticated
 * request) maps to the zero-privilege identity `{ roles: [] }`, so downstream
 * `can()` checks grant nothing.
 */
export const identityFromUser = (
  user: AuthUser | null | undefined,
  issuer: string = BETTER_AUTH_ISSUER,
  principalType: 'user' | 'service' = 'user',
): Identity => {
  if (!user || typeof user.id !== 'string' || user.id.length === 0) return { roles: [] };
  if (issuer.length === 0)
    throw new Error('@velajs/better-auth: identity issuer must be non-empty');
  return {
    issuer,
    subject: user.id,
    principalType,
    userId: user.id,
    roles: normalizeRoles(user.role),
  };
};

/**
 * The minimal slice of a better-auth access-control role consumed here. Both
 * `createAccessControl(...).newRole(...)` and the standalone `role(...)` return
 * `{ authorize, statements }`; `statements` is the `{ resource: actions[] }`
 * grant map for that role — the only accessor {@link betterAuthAcResolver}
 * reads.
 */
export interface BetterAuthAcRole {
  readonly statements: Readonly<Record<string, readonly string[]>>;
}

/**
 * Flattens a better-auth AC role's `statements` into `resource:action`
 * permission strings — the granted-side format `@velajs/authz` matches
 * (wildcards included).
 */
export const permissionsFromAcRole = (role: BetterAuthAcRole): string[] => {
  const permissions: string[] = [];
  for (const [resource, actions] of Object.entries(role.statements ?? {})) {
    for (const action of actions ?? []) permissions.push(`${resource}:${action}`);
  }
  return permissions;
};

/**
 * Builds a fail-closed `@velajs/authz` {@link PermissionResolver} from a
 * better-auth access-control role table (`{ roleName: acRole }` — the same map
 * shape passed to better-auth's admin/organization plugins). An identity's
 * `roles` are unioned into their granted permission strings; unknown roles
 * contribute nothing.
 *
 * ```ts
 * const ac = createAccessControl({ posts: ['read', 'write'] });
 * const authz = createAuthz({
 *   resolver: betterAuthAcResolver({ editor: ac.newRole({ posts: ['write'] }) }),
 * });
 * await authz.can(identityFromUser(user), 'posts:write');
 * ```
 */
export const betterAuthAcResolver = (
  roles: Readonly<Record<string, BetterAuthAcRole>>,
): PermissionResolver => {
  const grantsByRole = new Map<string, string[]>();
  for (const [name, role] of Object.entries(roles)) {
    grantsByRole.set(name, permissionsFromAcRole(role));
  }
  return {
    grants(identity: Identity): Set<string> {
      const out = new Set<string>();
      for (const name of identity.roles ?? []) {
        for (const permission of grantsByRole.get(name) ?? []) out.add(permission);
      }
      return out;
    },
  };
};
