# @velajs/tenant

Authoritative tenant admission and audited lifecycle management on Web APIs. The
root export is independent of Vela. Import `/vela`, `/d1`, `/postgres`, or
`/durable-objects` only when needed.

```ts
import { TenantService } from '@velajs/tenant';
import { D1TenantRegistryStore } from '@velajs/tenant/d1';

const tenants = new TenantService({
  lookup: new D1TenantRegistryStore(env.DB),
  authorize: ({ tenant, principal }) => memberships.authorize(tenant.id, principal),
});
await tenants.run({ tenantId: selector, principal: verifiedPrincipal }, async tenant => {
  return documents.execute('list', { tenant });
});
```

A selector is never authority. Admission canonicalizes the ID, reads the
registry, requires active status and membership authorization, then checks that
the authoritative revision has not changed during admission. The principal must
come from verified credentials. Supply an authoritative membership implementation;
positive caches require authoritative versions. A failed lookup or authorization
store fails the operation. Operations admitted before suspension may finish.

Snapshots and JSON settings are immutable. `run()` closes its capability when the
callback settles, including errors. `parent` scopes cannot change tenant or
principal. Construct services and stores per application/environment.

## Vela and event integration

Import `TenantModule`, `TenantGuard`, `TenantRequired`, `TenantOptional`,
`TenantIgnored`, `CurrentTenant`, and `TENANT_CONTEXT_READER` from `/vela`.
Register `TenantModule.forRoot({ lookup, authorize })` (or `forRootAsync`). It installs
`TenantGuard` as a global guard in the `tenant` phase: after global authentication and
before authorization, whatever the import order. It admits a tenant on every application route,
including routes in modules that do not import `TenantModule`, which admit through the
installing module, and whether or not it is registered with `isGlobal`. Mark tenant-free
routes with `@TenantIgnored()` or `@TenantOptional()`. An integration package's own
controller (the Better Auth handler, a storage controller) opts out with
`SkipGuardPhases(['tenant'])` from `@velajs/vela/module-kit`, which skips the
`TenantGuard` because it declares `static readonly skippable = true`. Pass `guard: 'none'`
(beside the factory for `forRootAsync`) to apply `@UseGuards(TenantGuard)` after a
route-level authentication guard instead; a route-level `TenantGuard` in a module that
cannot see `TenantModule` answers 403. Each `guard: 'global'` registration installs its
own global `TenantGuard`, including each keyed instance (`forRoot({ key, ... })`), and
every installed guard runs on every application route. The installed guard admits
through the `TenantModule` the route's module sees, so one global installation serves
every module: when several modules register their own configuration, give each
registration its own `key`, keep `guard: 'global'` on one and pass `guard: 'none'` on
the others. Required is the guard's default;
optional permits absence, but an explicit selector still requires authentication.
Ignored routes do not admit a tenant. Conflicting authenticated tenant IDs fail.
The guard publishes the canonical tenant into the trusted identity and CRUD's
compatibility variable. For generated tenant CRUD controllers, retain
`tenantResolverMounted: true` and apply the guard to the controller/module.

For a queue message, scheduled tenant, or WebSocket operation:

```ts
import { runInTenantScope, TENANT_CONTEXT_READER } from '@velajs/tenant/vela';
await runInTenantScope(app.getContainer(), {
  tenantId: message.tenantId, // selector only
  principal: verifiedServicePrincipal,
  source: 'queue',
}, async (container, tenant) => {
  // A fresh request-scoped child container; no HTTP context or AsyncLocalStorage.
  const reader = container.resolve(TENANT_CONTEXT_READER);
  return processMessage(message, reader);
});
```

Pass a declaring module ID when the application imports multiple tenant service
configurations. Each operation disposes its reader. A batch with several tenants
must admit each message independently. Durable Object routing is application
owned: choose a canonical tenant/object key and admit inside the addressed object.

Standalone Hono CRUD can retain `multiTenant` from `@velajs/crud/multi-tenant`:
use `admission: tenantAdmission(service, resolveVerifiedPrincipal)` from this
package. The adapter performs authoritative admission and returns the canonical
ID; authentication remains the resolver's responsibility.

## Registry and persistence

`TenantRegistry.save(record, expectedRevision, principal, reason)` creates with
`null` or updates using a revision compare-and-set. Set `status: 'suspended'` to
suspend, or `active` to resume. Registry administration has its own mandatory
authorization callback. Settings changes, status changes, and their audit records
commit atomically. Concurrent stale edits throw `TENANT_CONFLICT`.

`runForTenant(id, principal, reason, callback)` appends a durable administrative
audit before exposing a targeted administrative scope. Only `requireTenantTarget`
works on that scope; it cannot become ordinary CRUD/crypto tenant authority.
Use a separate privileged repository/credential inside administrative callbacks.
There is no global bypass flag. Directory `store.list({ after, limit })` and raw
store writes are infrastructure APIs: authorize their callers.

| Adapter | Initialization and boundary |
| --- | --- |
| D1 | Apply `tenantSqliteSchema`; use the primary database binding. CAS and audit use one atomic SQL batch. |
| PostgreSQL | Apply `tenantPostgresSchema`; pass a primary, cache-disabled client. CAS and audit use one statement. |
| Durable Objects | Call `store.migrate()` in the SQLite object. CAS and audit use `transactionSync`. |
| Memory | `MemoryTenantRegistryStore` owns its records and audits; useful for tests. |

`withTenantRls(executor, tenant, callback)` sets `vela.tenant_id` locally on the
same PostgreSQL transaction. `tenantRlsStatements(table, column)` enables and
forces matching USING/WITH CHECK policies. Run ordinary traffic under a role
without superuser/BYPASSRLS; keep administrative credentials separate.

Do not use KV, background polling, replica reads, or Hyperdrive query caches as
admission authority. Native bindings, SQL migrations, and membership stores are
application dependencies, never global framework state.

## Authentication composition

Global guards run AuthGuard or CloudflareAccessGuard (`authenticate`) before TenantGuard (`tenant`), then permission guards (`authorize`) and throttling (`feature`). Admission preserves authentication provider payload while publishing a new immutable tenant-bound identity. Clearing, replacement, or expiry invalidates both identity payload and the admitted request reader. For concurrent HTTP-backed resolver fields, admit the tenant once at the outer HTTP boundary and consume the request reader in each field.
