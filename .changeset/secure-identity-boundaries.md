---
'@velajs/better-auth': major
---

Run guards before ordinary identity parameters, install authentication globally and deny application routes by default, remove the insecure `defaultPolicy: 'allow'` mode and implicit auth-path bypass, enforce canonical auth mount paths, reject ambiguous authorization engines, and key module instances by the actual auth/factory reference. Anonymous routes must now use explicit `@Public()` or `@OptionalAuth()` metadata. Verified sessions now publish Vela's framework-owned principal identity and, when present, the Better Auth organization plugin's `activeOrganizationId` so downstream throttling can partition by principal and tenant before IP fallback.
