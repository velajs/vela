import { can } from './can';
import type { Identity, PermissionResolver } from './identity';
import type { PermissionDef, RoleDef } from './roles';

export interface Authz {
  can(identity: Identity, permission: string): Promise<boolean>;
  readonly resolver: PermissionResolver;
}

export interface CreateAuthzOptions {
  roles?: RoleDef[];
  permissions?: PermissionDef[];
  resolver?: PermissionResolver;
}

const isWildcard = (p: string): boolean => p === '*' || p.endsWith(':*');

/** Build a role→permission resolver over a role table (no module globals). */
const roleResolver = (roles: RoleDef[]): PermissionResolver => {
  const byRole = new Map<string, readonly string[]>();
  for (const r of roles) byRole.set(r.name, r.permissions);
  return {
    grants(identity: Identity): Set<string> {
      const out = new Set<string>();
      for (const name of identity.roles ?? []) {
        for (const perm of byRole.get(name) ?? []) out.add(perm);
      }
      return out;
    },
  };
};

export const createAuthz = (options: CreateAuthzOptions = {}): Authz => {
  const roles = options.roles ?? [];
  if (options.permissions) {
    const declared = new Set(options.permissions.map((p) => p.name));
    for (const role of roles) {
      for (const perm of role.permissions) {
        if (!isWildcard(perm) && !declared.has(perm)) {
          throw new Error(`role '${role.name}' grants undeclared permission '${perm}'`);
        }
      }
    }
  }
  const resolver = options.resolver ?? roleResolver(roles);
  return {
    resolver,
    can: (identity, permission) => can(identity, permission, resolver),
  };
};
