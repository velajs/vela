---
'@velajs/cloudflare-access': minor
---

Initial release: Zero Trust / OIDC identity verification for Vela.

- RS256-pinned JWKS verification (`verifyAccessJwt` / `verifyRequest`) with required, fail-closed audience checks and issuer/expiry enforcement.
- Issuer presets — `cloudflareAccessIssuer(teamDomain)` and `genericOidcIssuer(config)` — generalizing the Cloudflare wire constants so the package doubles as a generic OIDC/JWKS adapter.
- Per-issuer, isolate-lifetime, bounded (FIFO) JWKS cache with one `createRemoteJWKSet` per issuer.
- `defineIdentity` claim contract (declared type + Standard Schema v1 runtime validator in one declaration) with `onInvalid: 'anonymous' | 'reject'`, keeping the core jose-only.
- Structural `ResolveIdentity` contract, `createAccessResolver`, and `composeResolvers` ordered fallback (first non-null wins, else anonymous). `ResolvedIdentity` forwards `exp` / `expiresAtMs` as the WS socket-expiry data contract.
- `./vela` subpath: `CloudflareAccessModule`, `CloudflareAccessGuard`, `CurrentAccessIdentity`, `identityFromAccess` bridge to `@velajs/authz`, and `AccessPermissionGuard` + `@RequireAccessPermission`, with optional better-auth interop. Identity handoff is structural via `Symbol.for(...)` request-context keys.
