---
'@velajs/authz': minor
'@velajs/cloudflare-access': minor
---

Remove the deprecated `userId` identity alias.

**Behavior change:** `Identity.userId` (`@velajs/authz`) and `ResolvedIdentity.userId` (`@velajs/cloudflare-access`) are removed with no alias, and the request-identity projections no longer set them. Read `subject`, paired with `issuer`, as the durable principal key. `mapClaims` still cannot set a `userId` claim.
