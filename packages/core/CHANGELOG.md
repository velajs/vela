# Changelog

## 1.19.0

### Minor Changes

- dee0eb9: Remove the dead `IMPLEMENTED_ENDPOINTS` export (stale since the extended-verb
  registry landed — `resolveEnabledEndpoints` never read it; the live source of
  implemented verbs is the kernel extended-verb registry) and promote
  `clone.fieldsToReset` to a first-class, typed `clone?: { fieldsToReset?:
string[] }` on `CrudConfig` and `ResourceConfig` (previously read via an
  untyped cast in the clone executor).
- 68f05e4: ETag/If-Match optimistic concurrency and unique-constraint enforcement
  (hono-crud parity, closing the last two deferred conformance cells).
  `etag: true` on a resource makes reads emit a strong content-hash `ETag`
  (computed→mask→profile representation, stable across `?fields=`) and honor
  `If-None-Match` (304, empty body); updates honor `If-Match` and reject a
  stale tag with 409 CONFLICT (hono-crud's actual behavior — not 412). Model
  `unique` tuples (global scope; soft-deleted rows occupy the slot; null
  values never conflict) require the new `uniqueConstraints` adapter
  capability: the memory adapter enforces natively on create/update, and the
  drizzle adapter translates database unique-violations (sqlite/pg/mysql
  shapes) to 409 `ConflictException` — closing the constraint→409 concern for
  the in-repo adapters.
- 0dcc62b: Add the `id: 'client'` primary-key strategy: the caller-supplied PK stays in
  the derived CREATE body schema at its authored (typically required) shape —
  static derivation, the per-tenant resolveSchema path, and the OpenAPI DTO all
  follow — and the engine performs no generation (a create reaching the insert
  seam without a PK is a 400). Update-side schemas still exclude the PK, and the
  upsert/batchUpsert/import update legs never rewrite a matched row's PK (the
  body PK is insert-leg identity only). A custom `dto.create` that omits the PK
  under `id: 'client'` fails loudly at definition time. The memory adapter now
  throws a 409 `ConflictException` on a duplicate-PK create instead of silently
  overwriting. No adapter capability required; clone requires an `id` override.
  Retires the erpos `ClientPkCaptureGuard` workaround.
- b3fcdb6: Nested writes are now reachable end to end (hono-crud `nested-writes.ts`
  parity). New `nestedWrites` flags on `RelationConfig`
  (`allowCreate`/`allowUpdate`/`allowDelete`/`allowConnect`/`allowDisconnect`,
  all default off) merge the relation's write shape into the derived body
  schemas — CREATE accepts child payloads (single object for `hasOne`, array
  for `hasMany`; the child shape omits `['id', foreignKey]` plus the parent
  tenant column, which the engine force-stamps alongside defaulted timestamps
  when the child schema declares them), UPDATE accepts a flag-gated ops
  envelope (`create`/`update`/`delete`/`connect`/`disconnect`/`set`; `set`
  requires BOTH connect and disconnect flags) — and the single create/update
  verbs dispatch to the adapter's existing `NestedWriteDriver` inside the
  parent write's transaction (previously the driver was unreachable). Empty
  payloads are no-ops; id-only update entries are dropped; extended verbs
  (batch family, upsert, clone, bulkPatch, import) reject surviving nested
  payloads with a 400; live invalidation now also broadcasts the nested
  relations' `crud:<relatedTable>` tags. Security note (documented +
  define-time warning): `connect`/`set` relink related rows by id with no
  engine-side tenant/ownership check — use database RLS on tenant-scoped
  models. `belongsTo` nesting and create-via-`set` are deliberately
  unsupported; audit/version capture remains parent-scoped.
- 36cf850: Add `guards` to `CrudConfig`: `Partial<Record<CrudEndpointName, GuardType[]>>`,
  stamped per synthesized handler. Per-verb HTTP guards now work on both `@Crud`
  controllers and headless `CrudModule.forFeature` resources — exactly like
  hand-written routes with `@UseGuards`. Guards run after class-level `@UseGuards`
  and global guards (AND); `@Override`'d endpoints receive their declared config
  guards plus any of their own. Programmatic `resource.execute` dispatch is
  intentionally unaffected. Additive — existing configs stay valid.
- d6bf44e: Add model-level `serializationProfile` (`{ exclude }`) — hono-crud
  finalize-pipeline parity. Excluded fields are removed from every response body
  (list/read/create/update, batch, upsert, clone, restore, search hits, export
  JSON + CSV columns, import results, and same-model embedded relation rows);
  aggregate requests referencing an excluded field are rejected with a 400. The
  fields stay fully writable and intact at storage — filters and sorts match
  them, persistence-side lifecycle hooks and version/audit snapshots see the
  full row — and the strip wins over `?fields=` and
  `fieldSelection.alwaysInclude`. Response-transform hooks
  (`transformRead`/`transformList`) run after the strip, per hono-crud's
  profile-before-transform order. Proven by the new finalize-pipeline
  conformance cell over the memory and drizzle adapters.
- 2097825: Thread the request tenant into `adapter.transaction()`. New optional
  `TransactionContext` param (`{ tenantId? }`) is passed by the engine at every
  tx-open site; the drizzle adapter gains an `onOpenTransaction(tx, ctx)` config
  seam so consumers can issue `SET LOCAL <guc> = <tenant>` for Postgres RLS
  defense-in-depth. Additive: adapters and configs that ignore the context are
  unchanged.

## 1.18.1

### Patch Changes

- Wire `Model.resolveSchema` into request-time body validation: every
  body-validating verb now resolves the per-tenant schema and re-derives its
  body schema per request (explicit `dto` overrides still win). Fixes the
  tenant custom-fields regression found by the erpos migration.

## 1.18.0

### Minor Changes

- 7edf218: BREAKING — the engine is rewritten from scratch and the hono-crud dependency is
  removed. `@velajs/crud` is now the native Vela CRUD engine.

  - `@Crud()` stamps REAL controller routes (named routes → `urlFor`, full
    guard/pipe/interceptor pipeline, OpenAPI via the normal controller walk); the
    RouteContributor bridge is gone. Requires `@velajs/vela >= 1.18`.
  - New adapter contract: one plain-object `CrudAdapter` (5 core methods +
    declared capabilities + optional native methods). Adapters:
    `@velajs/crud-memory`, `@velajs/crud-drizzle` (sqlite exercised; pg/mysql
    branches present but untested).
  - All 22 verbs: core five + restore/clone/upsert, batch family + bulkPatch
    (X-Confirm-Bulk), search/aggregate (multi-op with aliases, having, group
    ordering)/export (CSV/JSON)/import, and the four version verbs.
  - Multi-tenant: `multiTenant()` resolver middleware + engine-level scoping +
    the `tenantResolverMounted` fail-fast. Versioning/audit: DI store seams
    (`VersioningStore`/`AuditStore`) with memory + drizzle implementations.
  - Live queries: `live: true` invalidates `crud:<table>` and stamps commit
    headers post-commit/pre-flush.
  - NOT ported in this release: response cache, rate-limit, idempotency, MCP,
    swagger/scalar UIs, prisma adapter, api-version, health, logging middleware,
    events/webhooks, field encryption, serialization profiles. See
    packages/core/PARITY.md for the full deviation ledger.

## 1.6.0 (2026-07-04)

- Migrated from the removed CrudBridge to the public `registerRouteContributor`; ComponentManager calls use `getScopedComponents` + explicit container. Requires `@velajs/vela >=1.11.0`.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (BREAKING)

- **Migrated to `hono-crud` 0.13** (peer `>=0.13.0`, was `>=0.11.0`; dev `^0.13.15`)
  and **`@hono/zod-openapi >=1.0.0`** (was `>=0.9`). hono-crud 0.13 split its
  exports across subpaths and extracted adapters into separate `@hono-crud/*`
  packages: the bridge's type imports moved to `hono-crud/config`
  (`AdapterBundle`/`EndpointsConfig`/`GeneratedEndpoints`), and the in-memory
  adapter moved to `@hono-crud/memory` (dev-only, used by the test harness).
- **Error response shape (consumer-facing).** hono-crud 0.13 unified every failure
  into one canonical envelope `{ success: false, error: { code, message, details? } }`
  with stable codes; `@velajs/crud` forwards these verbatim. Validation errors are
  now **400 `VALIDATION_ERROR`** (was 422) with `details: [{ path, message, code }]`;
  throw-sites carry real codes (`404 NOT_FOUND`, `403 FORBIDDEN`, `400 TENANT_REQUIRED`,
  `409 CONFLICT`, …). The success envelope is unchanged.

### Added

- **Record-versioning verbs (`versionHistory`/`versionRead`/`versionCompare`/
  `versionRollback`)** — surfaces the last four hono-crud verbs, completing the
  bridge's coverage (18 → 22). They are **gated behind model `versioning`**:
  enabled by default only when the model declares `versioning` (so existing
  non-versioned resources do not gain `/:id/versions*` routes that would 400).
  An explicit `only`/`endpoints` entry on a non-versioned model fails fast with
  an actionable "declare `versioning`" error. Derived operationIds read
  `list{Noun}Versions` / `get{Noun}Version` / `compare{Noun}Versions` /
  `rollback{Noun}Version`. New export: `VERSION_ENDPOINTS`.
- **`bulkPatch` endpoint** — surfaces hono-crud's collection-level `PATCH /bulk`
  (apply a partial update to a filtered set). Now part of `ALL_CRUD_ENDPOINTS`,
  `EndpointOverride`, route mounting, and the OpenAPI document.

### Fixed

- **vela ≥1.9.0 compat.** `ExecutionContext` requires `switchToWs()` since
  vela's WebSocket support landed; the CRUD guard-middleware bridge now provides
  it (throws for the HTTP context, mirroring vela's own HTTP `ExecutionContext`),
  so the package type-checks/builds against current `@velajs/vela`.
- **Default-endpoint hardening for partial adapter bundles.** hono-crud 0.13 throws
  at definition time when a configured verb's adapter slot is absent. A default
  mount (no `only`/`except`) now enables only the verbs the adapter bundle ships,
  so a partial custom `AdapterBundle` no longer crashes on verbs the consumer never
  asked for. An **explicitly** requested verb (via `only` or `endpoints.{verb}`)
  that the bundle lacks fails fast with a clear `@Crud:` error. New exports:
  `crudEndpointSlot`, `adapterProvidesEndpoint`.

### Changed

- Toolchain refresh: typescript ^5 → ^6.0.3, vitest ^4.0.18 → ^4.1.9, swc bumps,
  drizzle-orm (dev) ^0.36.4 → ^0.45.2.

## [1.2.0] — 2026-05-10

### Fixed

- `buildCrudRoutes`'s sub-app `onError` no longer swallows non-`HttpException`
  errors. Prior versions installed a catch-all that rendered a generic 500
  for anything that wasn't a `HttpException`, which silently lost error
  fidelity for any consumer that throws custom error subclasses (domain
  errors, framework filter chains, third-party middleware errors). The
  handler now keeps rendering `HttpException` locally and **rethrows**
  everything else so the parent app's `onError` (or any registered
  framework filter chain) can render them. Coverage:
  `src/__tests__/onerror-rethrow.test.ts`.

### Added

- `responseEnvelope?: ResponseEnvelope` on `CrudConfig` — forwarded
  verbatim to hono-crud's `RegisterCrudOptions.responseEnvelope` (added
  in hono-crud 0.10.0). When set, both `success(result, info?)` and
  `error(structuredError)` are the final formatting step before each
  response body is serialised. Each `forResource` /
  `defineCrudResource` / `@Crud` mount carries its own envelope, so
  different resources can ship different envelopes if needed. Omitting
  the option is byte-identical to the pre-0.10.0 default
  (`{ success: true, result, result_info? }`). Coverage:
  `src/__tests__/response-envelope-passthrough.test.ts`.
- Re-exports of `ResponseEnvelope`, `ResponseEnvelopeInfo`, and
  `StructuredError` from the package root, so consumers configuring
  `responseEnvelope` don't need a second import from `hono-crud`.

### Changed (BREAKING)

- Flat `CrudHooks.afterUpdate` and `CrudHooks.afterDelete` adopt
  hono-crud 0.10.0's two-snapshot shape — the bridge surface
  receives the **pre-mutation** row as `prior` and, for updates, the
  **post-mutation** row as `current`, with `ctx` hoisted to first arg.
  Per-endpoint hooks attached via `endpoints.{name}.hooks` continue to
  use hono-crud's native shape and are untouched.

  **Migration.** Update flat-sugar `afterUpdate` / `afterDelete`
  callbacks:

  ```diff
  CrudModule.forResource('/posts', {
    meta, adapters,
    hooks: {
  -   afterUpdate: (ctx, post) => emitChange(post),
  +   afterUpdate: (ctx, prior, current) => emitChange(prior, current),
  -   afterDelete: (ctx, id)   => emitDelete(id),
  +   afterDelete: (ctx, prior) => emitDelete(prior),
    },
  });
  ```

  The two-snapshot shape lets downstream consumers compute
  field-level diffs server-side (audit logs, CDC payloads, event
  bodies) without a re-fetch and without racing concurrent writers.
  Coverage: `src/__tests__/hooks.test.ts`.

### Compatibility

- Peer-dep bump: `hono-crud >=0.10.0` (was `>=0.7.0`). The
  `responseEnvelope` forwarding and the `afterUpdate`/`afterDelete`
  signature change both depend on the upstream's 0.10.0 surface.

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
  import { multiTenant } from "hono-crud";
  app.use("/*", multiTenant()); // mount upstream of the resource

  CrudModule.forResource("/posts", {
    meta: postMeta, // Model.multiTenant: true
    adapters,
    tenantResolverMounted: true, // affirmation
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
  - affirmation flag are pure bridge-side additions.

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
