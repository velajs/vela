---
"@velajs/cloudflare-access": minor
---

Publish verified Access principals, tenant membership, roles, claims and expiry to Vela's canonical trusted request identity. Clear stale identity before every authentication attempt and after failures. Remove compatibility symbols, ambient Hono userId writes, betterAuthInterop and duplicate permission APIs; use @velajs/authz/vela for shared authorization and CurrentIdentity. Retain CurrentAccessIdentity as provider-specific payload tied to the exact canonical identity, preserving mapClaims enrichment without using it as an authorization source. Select tenant membership from the signed tenantId claim or configured tenantClaim, forbid mapClaims from replacing it, and validate optional JWT claim shapes without assertions.
