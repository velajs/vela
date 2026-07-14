import type { Identity } from '@velajs/authz';
import type { ResolvedIdentity } from '../types';

/**
 * Adapt a verified {@link ResolvedIdentity} into a `@velajs/authz` {@link Identity}
 * so an Access caller is consumable by `authz.can(...)`. Maps `userId` → `userId`,
 * issuer `groups` → `roles`, and forwards the full verified claim set as `claims`.
 * The `@velajs/authz` import is **type-only**, so this bridge adds no runtime
 * dependency edge — the structural twin of better-auth's `identityFromUser`.
 */
export const identityFromAccess = (identity: ResolvedIdentity): Identity => ({
  userId: identity.userId,
  roles: identity.groups ?? [],
  claims: identity.claims,
});
