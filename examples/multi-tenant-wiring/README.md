# Multi-tenant wiring

Canonical wiring for a tenant-scoped `@velajs/crud` resource: `multiTenant: true` on the
model, the `multiTenant()` resolver mounted UPSTREAM of the Vela app (routes are built at
`VelaFactory.create()` time), and the mandatory `tenantResolverMounted: true` affirmation —
without it decoration throws `MissingTenantResolverError` instead of silently losing tenant
isolation.

```bash
pnpm --filter multi-tenant-wiring test
```
