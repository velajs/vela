# Multi-tenant wiring

Canonical wiring for a tenant-scoped `@velajs/crud` resource: `multiTenant: true` on the
model, the `multiTenant()` resolver mounted UPSTREAM of the Vela app (routes are built at
`VelaFactory.create()` time), and the mandatory `tenantResolverMounted: true` affirmation —
without it decoration throws `MissingTenantResolverError` instead of silently losing tenant
isolation.

Header/path/query tenant ids are selectors, not authorization. The resolver's mandatory
`validate` callback must check the authenticated user's tenant membership; it may read a
trusted result produced by an upstream guard, but there is no boolean bypass.

```bash
pnpm --filter multi-tenant-wiring test
```
