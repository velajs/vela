---
"@velajs/authz": major
---

Provide one PermissionGuard, RolesGuard, CurrentIdentity, and authorization decorator path under @velajs/authz/vela for all trusted authentication providers. Preserve tenant, issuer, subject, roles and credential expiry; reject ambiguous engines, stale identities, and expiry during async decisions. WebSocket authorization uses only normalized connection identity. Preserve policy context/resource generics instead of erasing them, and use checked DI provider descriptors while retaining resolved asynchronous module options.
