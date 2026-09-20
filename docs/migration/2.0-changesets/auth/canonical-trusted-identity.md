---
"@velajs/better-auth": minor
---

Publish fully validated Better Auth sessions through core's canonical expiring identity. Tie user/session parameters to that exact identity and clear them on public, logout, rejected, expired, or replaced authentication. Remove compatibility identity symbols and provider-specific role/permission APIs; import shared guards and decorators from @velajs/authz/vela. Replace Auth<any> with a minimal typed contract and preserve concrete API generics through BetterAuthService. Require explicit inject tuples for async factories, use nongeneric runtime Token constraints, and use checked provider descriptors with separate runtime configuration and remove the obsolete defaultPolicy option/default controller alias.
