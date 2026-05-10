# multi-tenant-wiring

Canonical wiring for a tenant-scoped `@velajs/crud` resource introduced in
**1.1.0**.

## What this shows

Three things, each enforced by the bridge:

1. **Tenant-scoped `Model`** — `multiTenant: true` on the model definition.
2. **Upstream tenant resolver** — `multiTenant()` middleware on the parent
   Hono app, mounted *before* the resource. Reads `X-Tenant-ID` and calls
   `c.set('tenantId', ...)`.
3. **Affirmation on the bridge config** — `tenantResolverMounted: true` on
   the `CrudModule.forResource(...)` call.

Removing step 3 throws `MissingTenantResolverError` synchronously at
module-load time. Without that throw, requests to the resource would
silently propagate `tenantId: undefined` into hooks, audit logs, events,
and CDC consumers — a data-loss bug class for any tenant-aware feature.

## Run

```sh
pnpm run smoke
```

Expected output: a 400 for the request with no `X-Tenant-ID` header,
isolated lists for `tenant-A` vs `tenant-B`, and a logged
`MissingTenantResolverError` from the negative case.
