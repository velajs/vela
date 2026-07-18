import type { Identity } from '@velajs/authz';
import type { ResolvedIdentity } from '../types';

/**
 * Adapt a verified {@link ResolvedIdentity} into a `@velajs/authz` {@link Identity}
 * so an Access caller is consumable by `authz.can(...)`. It forwards the stable
 * principal fields and application-local roles. External IdP groups are never
 * treated as local roles without an explicit resolver mapping.
 * The `@velajs/authz` import is **type-only**, so this bridge adds no runtime
 * dependency edge — the structural twin of better-auth's `identityFromUser`.
 */
export const identityFromAccess = (identity: ResolvedIdentity): Identity => {
  // Keep compiling against the previous authz peer while the coordinated
  // release adds these stable fields to Identity. Structural assignability
  // permits the richer object without an unsafe assertion.
  const mapped = {
    issuer: identity.issuer,
    subject: identity.subject,
    principalType: identity.principalType,
    userId: identity.userId,
    roles: identity.roles ?? [],
    claims: identity.claims,
  };
  return mapped;
};
