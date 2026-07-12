import type { Identity, PermissionResolver } from './identity';

/** Does the granted set satisfy `permission`, honoring wildcards? */
const granted = (grants: Set<string>, permission: string): boolean => {
  if (grants.has('*') || grants.has(permission)) return true;
  const colon = permission.indexOf(':');
  if (colon > 0 && grants.has(`${permission.slice(0, colon)}:*`)) return true;
  return false;
};

/**
 * The fail-closed capability check. Resolves the identity's granted permissions
 * via the resolver and matches `permission` (exact or wildcard). A resolver
 * that throws denies — there is no allow-on-error path.
 */
export const can = async (
  identity: Identity,
  permission: string,
  resolver: PermissionResolver,
): Promise<boolean> => {
  try {
    const grants = await resolver.grants(identity);
    return granted(grants, permission);
  } catch {
    return false;
  }
};
