# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-05-10

### Added
- `MissingTenantResolverError` — typed error thrown synchronously at
  module-load time when `CrudModule.forResource(...)`, `defineCrudResource(...)`,
  or `@Crud(...)` mounts a tenant-scoped `Model` without an affirmed tenant
  resolver. The error carries `tableName` and `mountPath` and its message
  spells out the canonical wiring fix. Exported from the package public
  surface so consumers can `catch (e) { if (e instanceof MissingTenantResolverError) ... }`.
- `tenantResolverMounted?: boolean` on `CrudConfig` — the affirmation flag.
  Set to `true` once the parent Hono app mounts a tenant resolver upstream
  of the resource (e.g. hono-crud's `multiTenant()` middleware, or any
  middleware that calls `c.set('tenantId', ...)`).
- `isTenantScopedMeta(meta)` helper — exported for consumers that want to
  reuse the bridge's tenant-scope detection logic (`Model.multiTenant === true`
  or a `MultiTenantConfig` object, or `Model.policies.readPushdown` set).
- `examples/multi-tenant-wiring` — runnable example showing the canonical
  three-step wiring: tenant-scoped `Model` + `multiTenant()` upstream +
  `tenantResolverMounted: true` on the bridge config.

### Changed (soft-breaking)
- Tenant-scoped `forResource(...)` calls now fail fast at module-load time
  unless `tenantResolverMounted: true` is set. Tenant scope is detected
  from `Model.multiTenant === true | MultiTenantConfig` or
  `Model.policies?.readPushdown`. Non-tenant-scoped resources are
  unaffected — the assertion fires only when the model itself declares
  tenant scope.

  **Why.** Without an upstream tenant resolver, `HookContext.tenantId` and
  `CrudEventPayload.tenantId` silently propagate as `undefined`, which is
  a data-loss bug class for any consumer that uses `multiTenant`-aware
  features (events, audit logs, CDC, hooks). Existing callers that mount
  tenant-scoped resources without a resolver were buggy by definition;
  the load-time throw surfaces the misconfiguration before it ships.

  **Migration.** Either wire a resolver and affirm it:
  ```ts
  import { multiTenant } from 'hono-crud';
  app.use('/*', multiTenant()); // mount upstream of the resource

  CrudModule.forResource('/posts', {
    meta: postMeta,                // Model.multiTenant: true
    adapters,
    tenantResolverMounted: true,   // affirmation
  });
  ```
  Or, if the model genuinely should not be tenant-scoped, remove
  `multiTenant` (and any `policies.readPushdown`) from the model.

### Deferred
- Forwarding hono-crud's new `prior` argument through the bridge's
  `mergeFlatHooks` translation, and forwarding hono-crud's new
  `responseEnvelope` option through `CrudConfig`, are deferred to a
  follow-up release. Both depend on the next minor of `hono-crud`
  shipping the relevant signatures; until then, the bridge cannot
  type-safely surface them.

### Compatibility
- No peer-dep change. `hono-crud` peer remains `>=0.7.0`. The new error
  + affirmation flag are pure bridge-side additions.

## [0.6.0] — 2026-05-03

### Added (verified pass-throughs)
- `requireApproval` middleware. First DELETE returns 202 + `actionId`; resume call replays original input. Coverage: `src/__tests__/require-approval-passthrough.test.ts`.
- `requirePolicy` middleware + `Model.policies` row-level rules (note: `ModelPolicies.read` signature is `(ctx, record)`). Coverage: `src/__tests__/require-policy-passthrough.test.ts`.
- `CrudEventPayload.organizationId` + `userId` populated from `c.var` (tenantId requires multi-tenant middleware to propagate to the payload). Coverage: `src/__tests__/event-payload-tenant-passthrough.test.ts`.
- Actor-aware approvals — `PendingAction.actorUserId` / `userId` / `agentId` / `agentRunId` populated by hono-crud's middleware. Coverage: `src/__tests__/actor-aware-approval-passthrough.test.ts`.

### Changed (BREAKING)
- Flat `CrudHooks` signatures gain a `HookContext` first parameter (transactional). `beforeCreate?: (data) => ...` is now `beforeCreate?: (ctx: HookContext, data) => ...`; the bridge flips arguments to forward into hono-crud's per-endpoint `(data, ctx)` shape. Per-endpoint `endpoints.{name}.hooks` continue to use hono-crud's native shape and win over flat sugar. Migration: prepend `ctx` (or `_ctx` if unused) to every flat-hook callback. Coverage: `src/__tests__/transactional-hooks.test.ts`.

### Notes
- `EndpointsConfig['delete'].middlewares` (and the same for other verbs) is NOT a real slot in hono-crud@0.7.0. Per-endpoint middleware attachment via `app.use(...)` with HTTP-method gating is the documented path; pass-through tests follow that pattern. If hono-crud later exposes a config-API slot, `@velajs/crud` can adopt it without API change.
- `HookContext.tenantId` / `organizationId` propagate only when a multi-tenant middleware runs upstream — raw `c.var.tenantId` does not auto-flow into the hook context. `CrudEventPayload` propagates `organizationId` from `c.var` directly.

### Compatibility
- No peer-dep change. `hono-crud` peer remains `>=0.7.0` (set in 0.4.0).

## [0.5.0] — 2026-05-03

### Verified
- `Model.resolveSchema` pass-through. Setting `meta.model.resolveSchema(ctx)` on a `@Crud` controller (or via `defineCrudResource`) lets hono-crud resolve a per-tenant schema for body validation and OpenAPI emission. No `@velajs/crud` API change — `meta` flows through `buildEndpointsDef → defineEndpoints` verbatim. Coverage: `src/__tests__/resolve-schema-passthrough.test.ts`.

### Compatibility
- No peer-dep change. `hono-crud` peer remains `>=0.7.0` (set in 0.4.0).

## [0.4.0] — 2026-05-03

### Added
- `CrudEndpointName` widened to mirror hono-crud's full surface: `search`, `aggregate`, `restore`, `batchCreate`, `batchUpdate`, `batchDelete`, `batchRestore`, `batchUpsert`, `export`, `import`, `upsert`, `clone`. `ALL_CRUD_ENDPOINTS` enumerates the 17-name surface; `EndpointOverride<M>` exposes a typed slot per name forwarded to hono-crud's `EndpointsConfig<M>`.
- `defineCrudResource(config)` ergonomic helper — bundles `CrudModule.forResource` + programmatic `@Override` application for plugin authors who want to skip the synthetic-controller pattern. Returns a `DynamicModule` that registers identically to `CrudModule.forResource(...)`. The existing `@Crud` decorator on user-written classes remains the canonical form.
- `drizzle-orm` and `drizzle-zod` added as devDependencies — required to import `hono-crud@^0.7.0`'s main bundle so the test suite genuinely exercises the bridge.

### Changed
- `validateEndpointNames` now accepts the widened name set; new tests at `src/__tests__/endpoint-widening.test.ts` cover each new verb end-to-end via `MemoryAdapters`.
- `crud-validation.test.ts` swapped its unknown-name sentinel from `'search'` (now valid) to `'NOT_A_VERB'`.

### Compatibility
- Peer-dep on `hono-crud` raised to `>=0.7.0` (covers the wider `EndpointsConfig` + `defineEndpoints` switch and the post-merge `Model.resolveSchema`/`HookContext`/`requireApproval`/`requirePolicy` surface used by 0.5.0 + 0.6.0 verifications later).
